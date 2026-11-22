#!/usr/bin/env python3
"""Hundredfold voice mode: the speech sidecar.

One process holds voice activity detection (Silero), speech-to-text (Parakeet through
`onnx-asr`) and text-to-speech (Kokoro through `kokoro-onnx`). The gateway spawns it with
the voice venv's Python and talks to it over stdin and stdout with length-prefixed
frames (specs/009-voice-mode/contracts/speech-sidecar.md):

    u32 BE headerLength | u32 BE bodyLength | header (UTF-8 JSON) | body (raw bytes)

Header at most 64 KB, body at most 4 MB. Standard library plus the pinned packages only;
the packages are imported when the models load, so the framing and dispatch run (and are
tested) without them.

Choices where the contract is silent:

* `hello.models` is `{"stt": {"name", "path", "quantization"}, "tts": {"model", "voices"},
  "vad": {"model"}}`: where the models live, as the gateway's bootstrap put them.
* A `vad.event` of kind `start` carries `atMs`, the stream offset to cut from so the
  utterance includes `prerollMs` of audio before speech began (never below 0). `end`
  carries the offset where speech stopped, before the trailing silence.
* A `--download` run fetches the models and prints one JSON object per line on stdout.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, BinaryIO, Callable, Iterable, Iterator

MAX_HEADER_BYTES = 64 * 1024
MAX_BODY_BYTES = 4 * 1024 * 1024

VAD_SAMPLE_RATE = 16000
VAD_FRAME_SAMPLES = 512  # Silero's window at 16 kHz
VAD_FRAME_MS = VAD_FRAME_SAMPLES * 1000 // VAD_SAMPLE_RATE
VAD_CONTEXT_SAMPLES = 64
# Below this the transducer has nothing to decode; pad with silence.
MIN_STT_SAMPLES = VAD_SAMPLE_RATE // 2

TTS_SAMPLE_RATE = 24000
# Cancelled ids are remembered so late replies for them are dropped; the oldest are forgotten.
MAX_REMEMBERED_CANCELS = 4096


class FramingError(Exception):
    """The peer sent something that is not a frame we can read."""


# ── framing ──────────────────────────────────────────────────────────────────


def encode_frame(header: dict[str, Any], body: bytes = b"") -> bytes:
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_HEADER_BYTES:
        raise FramingError(f"header of {len(raw)} bytes exceeds {MAX_HEADER_BYTES}")
    if len(body) > MAX_BODY_BYTES:
        raise FramingError(f"body of {len(body)} bytes exceeds {MAX_BODY_BYTES}")
    return struct.pack(">II", len(raw), len(body)) + raw + body


def _read_exact(stream: BinaryIO, count: int) -> bytes | None:
    """`count` bytes, or None on a clean end of stream at a boundary (count bytes missing)."""
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if remaining == count:
                return None
            raise FramingError("stream ended inside a frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _skip(stream: BinaryIO, count: int) -> None:
    while count:
        chunk = stream.read(min(count, 65536))
        if not chunk:
            raise FramingError("stream ended inside a frame")
        count -= len(chunk)


class Oversize(Exception):
    """A body larger than the limit; it was read past so the next frame stays aligned."""

    def __init__(self, header: dict[str, Any], size: int) -> None:
        super().__init__(f"body of {size} bytes exceeds {MAX_BODY_BYTES}")
        self.header = header


def read_frame(stream: BinaryIO) -> tuple[dict[str, Any], bytes] | None:
    """The next frame, or None at end of input. Raises `Oversize` for a body past the limit
    (after consuming it) and `FramingError` when the stream cannot be resynchronised."""
    prefix = _read_exact(stream, 8)
    if prefix is None:
        return None
    header_len, body_len = struct.unpack(">II", prefix)
    if header_len > MAX_HEADER_BYTES:
        raise FramingError(f"header of {header_len} bytes exceeds {MAX_HEADER_BYTES}")
    raw = _read_exact(stream, header_len) if header_len else b""
    if raw is None:
        raise FramingError("stream ended inside a frame")
    try:
        header = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError as error:
        _skip(stream, body_len)
        raise FramingError(f"header is not JSON: {error}") from error
    if not isinstance(header, dict):
        _skip(stream, body_len)
        raise FramingError("header is not an object")
    if body_len > MAX_BODY_BYTES:
        _skip(stream, body_len)
        raise Oversize(header, body_len)
    body = _read_exact(stream, body_len) if body_len else b""
    if body is None:
        raise FramingError("stream ended inside a frame")
    return header, body


# ── voice activity detection ─────────────────────────────────────────────────


class Endpointer:
    """Turns one speech probability per frame into `start` / `end` events.

    Speech starts once `min_speech_ms` of consecutive frames reach `threshold`; it ends
    after `silence_ms` of frames below `threshold - 0.15` (Silero's own hysteresis).
    """

    def __init__(self, threshold: float, min_speech_ms: int, silence_ms: int, preroll_ms: int) -> None:
        self.threshold = threshold
        self.low = max(0.0, threshold - 0.15)
        self.min_speech_frames = max(1, -(-min_speech_ms // VAD_FRAME_MS))
        self.silence_frames = max(1, -(-silence_ms // VAD_FRAME_MS))
        self.preroll_ms = preroll_ms
        self.frame = 0
        self.speaking = False
        self._run = 0  # consecutive frames at or above threshold, while not speaking
        self._silent = 0  # consecutive frames below the low mark, while speaking
        self._last_voiced = 0  # frame index after the last frame that was speech

    def push(self, probability: float) -> list[dict[str, Any]]:
        index = self.frame
        self.frame += 1
        if self.speaking:
            return self._while_speaking(index, probability)
        return self._while_quiet(index, probability)

    def _while_quiet(self, index: int, probability: float) -> list[dict[str, Any]]:
        self._run = self._run + 1 if probability >= self.threshold else 0
        if self._run < self.min_speech_frames:
            return []
        self.speaking = True
        self._silent = 0
        self._last_voiced = index + 1
        onset = (index + 1 - self._run) * VAD_FRAME_MS
        return [{"kind": "start", "atMs": max(0, onset - self.preroll_ms)}]

    def _while_speaking(self, index: int, probability: float) -> list[dict[str, Any]]:
        if probability >= self.low:
            self._silent = 0
            self._last_voiced = index + 1
            return []
        self._silent += 1
        if self._silent < self.silence_frames:
            return []
        self.speaking = False
        self._run = 0
        return [{"kind": "end", "atMs": self._last_voiced * VAD_FRAME_MS}]


class VadStream:
    """One attachment's continuous audio: buffers PCM16LE into frames, asks the model for a
    probability per frame, and feeds the endpointer. `model` is `probability(samples) -> float`
    over `VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES` samples as a bytes object of PCM16LE."""

    def __init__(self, model: "VadModel", endpointer: Endpointer) -> None:
        self.model = model
        self.endpointer = endpointer
        self._pending = b""
        self._context = bytes(VAD_CONTEXT_SAMPLES * 2)
        self._state = model.new_state()

    def write(self, pcm: bytes) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        self._pending += pcm
        size = VAD_FRAME_SAMPLES * 2
        while len(self._pending) >= size:
            frame, self._pending = self._pending[:size], self._pending[size:]
            probability, self._state = self.model.probability(self._context + frame, self._state)
            self._context = frame[-VAD_CONTEXT_SAMPLES * 2 :]
            events.extend(self.endpointer.push(probability))
        return events


class VadModel:
    """The seam the real Silero model and the tests' stub both fill."""

    def new_state(self) -> Any:  # pragma: no cover - interface
        raise NotImplementedError

    def probability(self, window: bytes, state: Any) -> tuple[float, Any]:  # pragma: no cover - interface
        raise NotImplementedError


class SileroOnnx(VadModel):
    """Silero VAD's ONNX export, run frame by frame (`onnx-asr` ships only a batch API over it)."""

    def __init__(self, model_path: str) -> None:
        import numpy as np
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self._np = np
        self._session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
        self._rate = np.array([VAD_SAMPLE_RATE], dtype=np.int64)

    def new_state(self) -> Any:
        return self._np.zeros((2, 1, 128), dtype=self._np.float32)

    def probability(self, window: bytes, state: Any) -> tuple[float, Any]:
        np = self._np
        samples = np.frombuffer(window, dtype="<i2").astype(np.float32) / 32768.0
        output, new_state = self._session.run(["output", "stateN"], {"input": samples[None, :], "state": state, "sr": self._rate})
        return float(output[0][0]), new_state


# ── speech-to-text and text-to-speech seams ──────────────────────────────────


class SttModel:
    def recognize(self, pcm: bytes) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class TtsModel:
    voices: list[str] = []

    def synthesize(self, text: str, voice: str, speed: float, lang: str) -> Iterator[tuple[bytes, int]]:  # pragma: no cover - interface
        raise NotImplementedError


def _providers(device: str) -> tuple[list[str], str]:
    """The ONNX Runtime providers for `device`, and the device that results (gpu or cpu)."""
    import onnxruntime as ort

    if device != "cpu" and "CUDAExecutionProvider" in ort.get_available_providers():
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()  # find the pip-installed CUDA and cuDNN libraries before any CUDA session
        return ["CUDAExecutionProvider", "CPUExecutionProvider"], "gpu"
    return ["CPUExecutionProvider"], "cpu"


class ParakeetOnnx(SttModel):
    def __init__(self, spec: dict[str, Any], providers: list[str]) -> None:
        import numpy as np
        import onnx_asr

        self._np = np
        self._asr = onnx_asr.load_model(
            spec.get("name", "nemo-parakeet-tdt-0.6b-v2"), path=spec["path"], quantization=spec.get("quantization"), providers=providers
        )

    def recognize(self, pcm: bytes) -> str:
        np = self._np
        samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0
        if samples.size < MIN_STT_SAMPLES:
            samples = np.pad(samples, (0, MIN_STT_SAMPLES - samples.size))
        return str(self._asr.recognize(samples, sample_rate=VAD_SAMPLE_RATE)).strip()


def kokoro_language(voice: str, lang: str) -> str:
    """Kokoro's phonemiser wants `en-us` or `en-gb`; the voice's own prefix says which."""
    if lang.lower().startswith("en"):
        return "en-gb" if voice[:1] == "b" else "en-us"
    return lang


class KokoroOnnx(TtsModel):
    def __init__(self, spec: dict[str, Any], providers: list[str]) -> None:
        import numpy as np
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        self._np = np
        session = ort.InferenceSession(spec["model"], providers=providers)
        self._kokoro = Kokoro.from_session(session, spec["voices"])
        self.voices = list(self._kokoro.get_voices())
        self.device = "gpu" if session.get_providers()[0] == "CUDAExecutionProvider" else "cpu"

    def synthesize(self, text: str, voice: str, speed: float, lang: str) -> Iterator[tuple[bytes, int]]:
        import asyncio

        np = self._np
        loop = asyncio.new_event_loop()
        stream = self._kokoro.create_stream(text, voice=voice, speed=speed, lang=kokoro_language(voice, lang))
        try:
            while True:
                try:
                    samples, rate = loop.run_until_complete(stream.__anext__())
                except StopAsyncIteration:
                    return
                pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                yield pcm, int(rate)
        finally:
            loop.run_until_complete(stream.aclose())
            loop.close()


class Models:
    """What `hello` loads; the tests build one from stubs."""

    def __init__(self, vad: VadModel, stt: SttModel, tts: TtsModel, device: str) -> None:
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.device = device


def load_models(hello: dict[str, Any]) -> Models:
    specs = hello.get("models") or {}
    providers, device = _providers(str(hello.get("device", "auto")))
    stt = ParakeetOnnx(specs["stt"], providers)
    tts = KokoroOnnx(specs["tts"], providers)
    vad = SileroOnnx(specs["vad"]["model"])
    warm_up(stt, tts)
    return Models(vad, stt, tts, "gpu" if device == "gpu" and tts.device == "gpu" else "cpu")


def warm_up(stt: SttModel, tts: TtsModel) -> None:
    """One throwaway decode and synthesis, so the first spoken turn does not pay for the CUDA
    kernels and graph setup. A failure here is not fatal: the first real request will say why."""
    try:
        stt.recognize(bytes(MIN_STT_SAMPLES * 2))
        for _ in tts.synthesize("Ready.", tts.voices[0] if tts.voices else "af_heart", 1.0, "en"):
            pass
    except Exception:
        sys.stderr.write("warm-up failed:\n" + traceback.format_exc())


# ── the server ───────────────────────────────────────────────────────────────


class Server:
    """Reads frames, runs each op, writes replies. VAD runs on the reading thread (it is
    ordered per stream and cheap); decodes and syntheses run on workers, so a long synthesis
    never holds up a `cancel` or a `ping`."""

    def __init__(self, reader: BinaryIO, writer: BinaryIO, loader: Callable[[dict[str, Any]], Models] = load_models) -> None:
        self._reader = reader
        self._writer = writer
        self._loader = loader
        self._write_lock = threading.Lock()
        self._cancelled: dict[str, None] = {}  # ids are unique; an ordered set, capped
        self._models: Models | None = None
        self._vads: dict[str, VadStream] = {}
        self._unknown_vad: dict[str, None] = {}  # streams already reported, so a flood of audio gets one error
        self._stt_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")
        self._tts_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tts")
        self._ops: dict[str, Callable[[dict[str, Any], bytes], None]] = {
            "hello": self._hello, "vad.open": self._vad_open, "vad.audio": self._vad_audio, "vad.close": self._vad_close,
            "stt.partial": lambda h, b: self._stt(h, b, False), "stt.final": lambda h, b: self._stt(h, b, True),
            "tts": self._tts, "cancel": self._cancel, "ping": self._ping,
        }

    # replies

    def send(self, header: dict[str, Any], body: bytes = b"", key: str | None = None) -> bool:
        """Write a reply unless `key` was cancelled; the check and the write share the lock, so
        nothing for a cancelled id leaves after `cancel` has been handled."""
        data = encode_frame(header, body)
        with self._write_lock:
            if key is not None and key in self._cancelled:
                return False
            self._writer.write(data)
            self._writer.flush()
        return True

    def error(self, ref: Any, message: str, **extra: Any) -> None:
        self.send({"op": "error", "ref": ref, "message": message, **extra})

    # loop

    def serve(self) -> int:
        try:
            while True:
                try:
                    frame = read_frame(self._reader)
                except Oversize as oversize:
                    self.error(_ref(oversize.header), str(oversize))
                    continue
                except FramingError as error:
                    self.error(None, str(error))
                    return 2
                if frame is None:
                    return 0
                self._dispatch(*frame)
        finally:
            self._stt_pool.shutdown(wait=False, cancel_futures=True)
            self._tts_pool.shutdown(wait=False, cancel_futures=True)

    def _dispatch(self, header: dict[str, Any], body: bytes) -> None:
        op = header.get("op")
        handler = self._ops.get(op) if isinstance(op, str) else None
        if handler is None:
            return self.error(_ref(header), f"unknown op {op!r}")
        try:
            handler(header, body)
        except Exception as error:  # an op's failure answers that op, never ends the process
            sys.stderr.write(traceback.format_exc())
            self.error(_ref(header), f"{op} failed: {error}")

    # ops

    def _hello(self, header: dict[str, Any], _body: bytes) -> None:
        try:
            self._models = self._loader(header)
        except Exception as error:
            sys.stderr.write(traceback.format_exc())
            return self.error("hello", f"could not load the speech models: {error}")
        self.send({"op": "ready", "device": self._models.device, "voices": list(self._models.tts.voices), "sttPartials": True})

    def _need_models(self, header: dict[str, Any]) -> Models | None:
        if self._models is None:
            self.error(_ref(header), "send hello first")
        return self._models

    def _vad_open(self, header: dict[str, Any], _body: bytes) -> None:
        models = self._need_models(header)
        if models is None:
            return
        endpointer = Endpointer(
            float(header.get("threshold", 0.5)), int(header.get("minSpeechMs", 250)), int(header.get("silenceMs", 1000)), int(header.get("prerollMs", 300))
        )
        stream = str(header["stream"])
        self._unknown_vad.pop(stream, None)
        self._vads[stream] = VadStream(models.vad, endpointer)

    def _vad_audio(self, header: dict[str, Any], body: bytes) -> None:
        stream = str(header.get("stream"))
        vad = self._vads.get(stream)
        if vad is None:
            # Audio keeps arriving for a stream the sidecar never opened or has lost (it restarted): say so once.
            if stream not in self._unknown_vad:
                self._unknown_vad[stream] = None
                while len(self._unknown_vad) > MAX_REMEMBERED_CANCELS:
                    del self._unknown_vad[next(iter(self._unknown_vad))]
                self.error(stream, "no such vad stream")
            return
        for event in vad.write(body):
            self.send({"op": "vad.event", "stream": stream, **event})

    def _vad_close(self, header: dict[str, Any], _body: bytes) -> None:
        self._vads.pop(str(header.get("stream")), None)

    def _stt(self, header: dict[str, Any], body: bytes, final: bool) -> None:
        models = self._need_models(header)
        if models is None:
            return
        utterance = str(header.get("utterance"))
        stream = header.get("stream")
        self._stt_pool.submit(self._decode, models, utterance, stream, body, final)

    def _decode(self, models: Models, utterance: str, stream: Any, pcm: bytes, final: bool) -> None:
        if utterance in self._cancelled:
            return
        try:
            text = models.stt.recognize(pcm)
        except Exception as error:
            sys.stderr.write(traceback.format_exc())
            return self._reply_error(utterance, f"stt failed: {error}", final=final)
        self.send({"op": "stt.text", "stream": stream, "utterance": utterance, "text": text, "final": final}, key=utterance)

    def _reply_error(self, key: str, message: str, **extra: Any) -> None:
        if key not in self._cancelled:
            self.error(key, message, **extra)

    def _tts(self, header: dict[str, Any], _body: bytes) -> None:
        models = self._need_models(header)
        if models is None:
            return
        request = str(header.get("id"))
        self._tts_pool.submit(self._speak, models, request, header)

    def _speak(self, models: Models, request: str, header: dict[str, Any]) -> None:
        voice = str(header.get("voice") or "af_heart")
        chunks: Iterable[tuple[bytes, int]] | None = None
        try:
            chunks = models.tts.synthesize(str(header.get("text", "")), voice, float(header.get("speed", 1.0)), str(header.get("lang", "en")))
            for pcm, rate in chunks:
                if request in self._cancelled or not self.send({"op": "tts.audio", "id": request, "sampleRate": rate}, pcm, key=request):
                    return
            self.send({"op": "tts.done", "id": request}, key=request)
        except Exception as error:
            sys.stderr.write(traceback.format_exc())
            self._reply_error(request, f"tts failed: {error}")
        finally:
            close = getattr(chunks, "close", None)
            if close:
                close()

    def _cancel(self, header: dict[str, Any], _body: bytes) -> None:
        target = str(header.get("id"))
        with self._write_lock:
            self._cancelled[target] = None
            while len(self._cancelled) > MAX_REMEMBERED_CANCELS:
                del self._cancelled[next(iter(self._cancelled))]

    def _ping(self, header: dict[str, Any], _body: bytes) -> None:
        self.send({"op": "pong", "n": header.get("n")})


def _ref(header: dict[str, Any]) -> Any:
    for key in ("id", "stream", "utterance"):
        if key in header:
            return header[key]
    return None


# ── model download (--download) ──────────────────────────────────────────────

KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


def _say(**fields: Any) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def download(spec: dict[str, Any]) -> int:
    """Fetch the models named by `spec` into their directories, one JSON line per step. Uses
    `local_dir` throughout: ONNX Runtime refuses weights reached through the shared Hugging
    Face cache's symlinked blobs."""
    from onnx_asr.loader import create_asr_resolver, create_vad_resolver

    stt = spec["stt"]
    _say(step="stt", name=stt["name"])
    create_asr_resolver(stt["name"], stt["path"], offline=False).resolve_model(quantization=stt.get("quantization"))
    _say(step="vad")
    create_vad_resolver("silero", spec["vad"]["path"], offline=False).resolve_model()
    for name, dest in (("kokoro-v1.0.onnx", spec["tts"]["model"]), ("voices-v1.0.bin", spec["tts"]["voices"])):
        _say(step="tts", name=name)
        _fetch(f"{KOKORO_RELEASE}/{name}", dest)
    _say(step="done")
    return 0


def _fetch(url: str, dest: str) -> None:
    import urllib.request

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    partial = dest + ".downloading"
    with urllib.request.urlopen(url, timeout=60) as response, open(partial, "wb") as out:  # noqa: S310 - fixed https release URL
        while True:
            block = response.read(1 << 20)
            if not block:
                break
            out.write(block)
    os.replace(partial, dest)


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "--download":
        return download(json.loads(argv[2]))
    # Frames own stdout; anything a library prints must not corrupt them.
    reader, writer = sys.stdin.buffer, os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    sys.stdout = sys.stderr
    return Server(reader, writer).serve()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
