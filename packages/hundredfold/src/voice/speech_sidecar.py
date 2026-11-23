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

* `hello.models` is `{"stt": {"name", "path", "quantization", "streaming"?, "download"?}, "tts": {"model",
  "voices"}, "vad": {"model"}}`: where the models live, as the gateway's bootstrap put them. `streaming` is
  true for the buffered streaming Parakeet Unified export; `download` is the pinned-file spec a `--download`
  run fetches.
* A `vad.event` of kind `start` carries `atMs`, the stream offset to cut from so the
  utterance includes `prerollMs` of audio before speech began (never below 0). `end`
  carries the offset where speech stopped, before the trailing silence.
* A `--download` run fetches the models and prints one JSON object per line on stdout.
* Speech-to-text keeps state per utterance id. The contract's `stt.partial` / `stt.final` carry the
  whole utterance so far, and the audio of one id only ever grows, so a streaming model decodes just
  the part it has not seen and carries its decoder state to the next request; a model that is not
  streaming decodes the whole buffer each time, as before. The state is dropped by the `final`, a
  `cancel`, an error, or (for abandoned utterances) the cap on how many are kept.
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

    def transcribe(self, utterance: str, pcm: bytes, final: bool) -> str:
        """The text of the utterance so far (`pcm` is all of it). A model with per-utterance state overrides this."""
        return self.recognize(pcm)

    def forget(self, utterance: str) -> None:
        """The utterance is over or cancelled: drop what is kept for it."""

    def warm(self) -> None:
        """One throwaway decode, so the first spoken turn does not pay for the kernels and graph setup."""
        self.recognize(bytes(MIN_STT_SAMPLES * 2))


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


# On the GPU an offline utterance is padded with silence up to the next of these lengths (seconds), and the real length
# is passed along, as in a padded batch. A longer one keeps its own length: it is rare, and its run is long enough that
# planning the graph once more is a small share of it (and padding it would cost memory on a shared GPU).
OFFLINE_PAD_SECONDS = (4, 8, 12, 16, 24, 32)


def _out_of_memory(error: BaseException) -> bool:
    text = str(error)
    return "Failed to allocate memory" in text or "CUBLAS_STATUS_ALLOC_FAILED" in text or "out of memory" in text.lower()


class ParakeetOnnx(SttModel):
    def __init__(self, spec: dict[str, Any], providers: list[str]) -> None:
        import numpy as np
        import onnx_asr

        self._np = np
        self._asr = onnx_asr.load_model(
            spec.get("name", "nemo-parakeet-tdt-0.6b-v2"), path=spec["path"], quantization=spec.get("quantization"), providers=providers
        )
        # The CUDA provider plans the graph again for every input length it has not just seen (about 200 ms, against 30 to 150 ms for the
        # run itself on a short utterance), so on the GPU the audio is padded to a handful of lengths and `recognize_batch` is told the real one.
        # The CPU runs any length at no extra cost, and padding would only add work there.
        self._pad_to = tuple(seconds * VAD_SAMPLE_RATE for seconds in OFFLINE_PAD_SECONDS) if "CUDAExecutionProvider" in providers else ()

    def recognize(self, pcm: bytes) -> str:
        np = self._np
        samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0
        if samples.size < MIN_STT_SAMPLES:
            samples = np.pad(samples, (0, MIN_STT_SAMPLES - samples.size))
        real = samples.size
        try:
            if not self._pad_to:
                return str(self._asr.recognize(samples, sample_rate=VAD_SAMPLE_RATE)).strip()
            padded = next((size for size in self._pad_to if size >= real), real)
            if padded > real:
                samples = np.pad(samples, (0, padded - real))
            result = next(self._asr.asr.recognize_batch(samples[None, :], np.array([real], dtype=np.int64)))
            return str(result.text).strip()
        except Exception as error:
            if self._pad_to and _out_of_memory(error):
                # Only the GPU path: the CPU's own errors are reported as they are.
                # The encoder's memory grows with the length of the audio (about 3.5 GB in all for a minute, 5 to 7 GB for two) and
                # onnxruntime keeps what it took; when other programs hold most of the GPU, a long utterance does not fit.
                raise RuntimeError(f"the GPU ran out of memory on {real / VAD_SAMPLE_RATE:.0f} s of audio; other programs are probably holding it") from error
            raise

    def warm(self) -> None:
        # One throwaway decode per padded length, so the first utterance of each does not pay for planning its graph.
        for size in self._pad_to or (MIN_STT_SAMPLES,):
            self.recognize(bytes(size * 2))


# ── streaming speech-to-text ─────────────────────────────────────────────────

STREAM_HOP = 160  # samples per feature frame (10 ms at 16 kHz)
# Utterances whose state is kept at once. One is live at a time; the rest are abandoned ones that
# never got a `final` or a `cancel`.
MAX_STREAMS = 8


class StreamEngine:
    """What `StreamingUtterance` needs of a model: the seam the real Parakeet and the tests' stub both fill.
    The window geometry is in feature frames (10 ms each); `encode` takes PCM16LE and returns the encoder
    frames of the window (indexable by frame, at least `count` of them)."""

    left_frames: int
    chunk_frames: int
    right_frames: int
    subsampling: int
    blank: int
    max_tokens: int

    def encode(self, window: bytes) -> tuple[Any, int]:  # pragma: no cover - interface
        raise NotImplementedError

    def new_state(self) -> Any:  # pragma: no cover - interface
        raise NotImplementedError

    def step(self, tokens: list[int], state: Any, frame: Any) -> tuple[int, Any]:  # pragma: no cover - interface
        """One joint step: the best token for `frame` (the blank when nothing is emitted) and the decoder state that follows it."""
        raise NotImplementedError

    def text(self, tokens: list[int]) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class StreamingUtterance:
    """Buffered streaming decoding of one utterance (NVIDIA's chunked scheme for Parakeet Unified, as the sherpa-onnx
    reference script runs it): the encoder sees a window of left context, one chunk and right context, and only the
    chunk's frames are decoded; the next window slides on by one chunk. Every request carries the whole utterance so
    far; only the audio past what an earlier request consumed is stepped through, and the decoder state is kept, so
    the work over an utterance is linear in its length and a `final` only decodes what is left."""

    def __init__(self, engine: StreamEngine) -> None:
        self.engine = engine
        self.chunk = engine.chunk_frames * STREAM_HOP
        self.right = engine.right_frames * STREAM_HOP
        self.capacity = engine.left_frames * STREAM_HOP + self.chunk + self.right
        self.reset()

    def reset(self) -> None:
        self.window = b""  # PCM16LE: the last `capacity` samples seen
        self.left = self.center = self.pending = 0  # samples of the window that are context, decoded-next, and right context
        self.taken = 0  # samples of the utterance stepped through
        self.tokens: list[int] = []
        self.state = self.engine.new_state()

    def advance(self, pcm: bytes, final: bool) -> str:
        """The text of the utterance so far. `pcm` is all of it; a `final` also decodes the tail that has no right context."""
        total = len(pcm) // 2
        if total < self.taken:  # the utterance did not only grow: start over rather than decode a splice
            self.reset()
        while True:
            need = self.chunk + self.right if self.taken == 0 else self.chunk
            available = total - self.taken
            if available >= need and not (final and available == need):
                self._step(pcm[self.taken * 2 : (self.taken + need) * 2], False)
                self.taken += need
            elif final:
                self._step(pcm[self.taken * 2 : total * 2], True)
                self.taken = total
                break
            else:
                break
        return self.engine.text(self.tokens)

    def _step(self, new: bytes, last: bool) -> None:
        added = len(new) // 2
        self.window += new
        self.left += self.center
        self.center = 0
        self.pending += added
        if last:
            self.center, self.pending = self.pending, 0
        elif self.pending > self.chunk:
            self.center, self.pending = self.chunk, self.pending - self.chunk
        excess = max(len(self.window) // 2 - self.capacity, 0)
        self.left -= excess
        self.window = self.window[excess * 2 :]
        if not self.window:
            return
        frames, count = self.engine.encode(self.window)
        per_frame = STREAM_HOP * self.engine.subsampling
        first = self.left // per_frame
        stop = min(first + (count - first if last else self.center // per_frame), count)
        for index in range(first, stop):
            self._decode(frames[index])

    def _decode(self, frame: Any) -> None:
        for _ in range(self.engine.max_tokens):
            token, state = self.engine.step(self.tokens, self.state, frame)
            if token == self.engine.blank:
                return
            self.state = state
            self.tokens.append(token)


class OnnxAsrStreamEngine(StreamEngine):
    """The engine over a loaded `onnx-asr` NeMo RNN-T model whose encoder is one of the buffered streaming exports.
    It reaches into the model for its feature extractor, sessions and vocabulary: `onnx-asr` has no streaming API,
    and the version is pinned (see `speech-sidecar.md`)."""

    _NEEDED = ("_preprocessor", "_encode", "_create_state", "_decode", "_decode_tokens", "_blank_idx", "_max_tokens_per_step")

    def __init__(self, asr: Any, np: Any, pad_windows: bool) -> None:
        missing = [name for name in self._NEEDED if not hasattr(asr, name)]
        if missing:
            raise RuntimeError(f"the installed onnx-asr has no {', '.join(missing)}; streaming speech-to-text needs the pinned version")
        meta = asr._encoder.get_modelmeta().custom_metadata_map
        if meta.get("streaming_model_type") != "nemo_parakeet_unified_streaming":
            raise RuntimeError("the encoder is not a Parakeet Unified streaming export (its metadata names no streaming_model_type)")
        self._asr = asr
        self._np = np
        self.left_frames = int(meta["left_feature_frames"])
        self.chunk_frames = int(meta["chunk_feature_frames"])
        self.right_frames = int(meta["right_feature_frames"])
        self.subsampling = int(meta["subsampling_factor"])
        # The longest window, when every window is to be padded to it (see `encode`); 0 leaves them as they are.
        self._pad_to = (self.left_frames + self.chunk_frames + self.right_frames) * STREAM_HOP if pad_windows else 0
        self.blank = asr._blank_idx
        self.max_tokens = asr._max_tokens_per_step

    def encode(self, window: bytes) -> tuple[Any, int]:
        np = self._np
        samples = np.frombuffer(window, dtype="<i2").astype(np.float32) / 32768.0
        real = max(samples.size, MIN_STT_SAMPLES)
        if self._pad_to:
            # CUDA re-plans the graph (about 250 ms, against about 30 ms for the run itself) whenever the input length differs
            # from the last few it saw, and a window grows by a chunk at a time. So on the GPU every window is padded with
            # silence to the longest one and `length` says how much of it is real, as in a padded batch: one shape, the same transcript.
            samples = np.pad(samples, (0, self._pad_to - samples.size))
        elif samples.size < real:
            samples = np.pad(samples, (0, real - samples.size))
        features, lengths = self._asr._preprocessor(samples[None, :], np.array([real], dtype=np.int64))
        encoded, encoded_lengths = self._asr._encode(features, lengths)
        return encoded[0], int(encoded_lengths[0])

    def new_state(self) -> Any:
        return self._asr._create_state()

    def step(self, tokens: list[int], state: Any, frame: Any) -> tuple[int, Any]:
        logits, _, new_state = self._asr._decode(tokens, state, frame)
        return int(logits.argmax()), new_state

    def text(self, tokens: list[int]) -> str:
        return str(self._asr._decode_tokens(tokens, None, None).text).strip()


class StreamingStt(SttModel):
    """A speech-to-text model that decodes each utterance incrementally: one `StreamingUtterance` per utterance id, so partials
    and the final share one decoding of the utterance instead of each decoding the whole buffer again."""

    def __init__(self, engine: StreamEngine) -> None:
        self._engine = engine
        self._lock = threading.Lock()
        self._streams: dict[str, StreamingUtterance] = {}

    def recognize(self, pcm: bytes) -> str:
        return StreamingUtterance(self._engine).advance(pcm, True)

    def transcribe(self, utterance: str, pcm: bytes, final: bool) -> str:
        with self._lock:
            stream = self._streams.pop(utterance, None) or StreamingUtterance(self._engine)
            self._streams[utterance] = stream  # most recently used last
            while len(self._streams) > MAX_STREAMS:
                del self._streams[next(iter(self._streams))]
        try:
            text = stream.advance(pcm, final)
        except Exception:
            self.forget(utterance)  # a step that failed half way leaves the state unusable: the next request starts over
            raise
        if final:
            self.forget(utterance)
        return text

    def forget(self, utterance: str) -> None:
        with self._lock:
            self._streams.pop(utterance, None)

    def warm(self) -> None:
        # Seven seconds of silence walk the window through every size it takes while it fills (one shape per chunk).
        self.recognize(bytes(14 * VAD_SAMPLE_RATE))


class ParakeetStreamingOnnx(StreamingStt):
    """Parakeet Unified through its chunked streaming encoder, loaded as `onnx-asr` loads any NeMo RNN-T model."""

    def __init__(self, spec: dict[str, Any], providers: list[str]) -> None:
        loaded = ParakeetOnnx(spec, providers)
        super().__init__(OnnxAsrStreamEngine(loaded._asr.asr, loaded._np, pad_windows="CUDAExecutionProvider" in providers))


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
    stt = (ParakeetStreamingOnnx if specs["stt"].get("streaming") else ParakeetOnnx)(specs["stt"], providers)
    tts = KokoroOnnx(specs["tts"], providers)
    vad = SileroOnnx(specs["vad"]["model"])
    warm_up(stt, tts)
    return Models(vad, stt, tts, "gpu" if device == "gpu" and tts.device == "gpu" else "cpu")


def warm_up(stt: SttModel, tts: TtsModel) -> None:
    """One throwaway decode and synthesis, so the first spoken turn does not pay for the CUDA
    kernels and graph setup. A failure here is not fatal: the first real request will say why."""
    try:
        stt.warm()
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
            text = models.stt.transcribe(utterance, pcm, final)
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
        if self._models is not None:
            self._models.stt.forget(target)

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
    Face cache's symlinked blobs. `spec["only"]`, when present, lists the steps to run
    (`stt`, `vad`, `tts`); a missing list runs them all."""
    only = spec.get("only")

    def wanted(step: str) -> bool:
        return only is None or step in only

    stt = spec["stt"]
    if wanted("stt"):
        _say(step="stt", name=stt["name"])
        if stt.get("download"):
            _download_pinned(stt["path"], stt["download"])
        else:
            from onnx_asr.loader import create_asr_resolver

            create_asr_resolver(stt["name"], stt["path"], offline=False).resolve_model(quantization=stt.get("quantization"))
    if wanted("vad"):
        from onnx_asr.loader import create_vad_resolver

        _say(step="vad")
        create_vad_resolver("silero", spec["vad"]["path"], offline=False).resolve_model()
    if wanted("tts"):
        for name, dest in (("kokoro-v1.0.onnx", spec["tts"]["model"]), ("voices-v1.0.bin", spec["tts"]["voices"])):
            _say(step="tts", name=name)
            _fetch(f"{KOKORO_RELEASE}/{name}", dest)
    _say(step="done")
    return 0


def _sha256(path: str) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _link_existing(dest: str, target: str, entry: dict[str, Any]) -> bool:
    """Put an identical copy of the file (`entry["reuse"]`, relative to `dest`: another model's copy of the same weights) at
    `target` when one is there with the right hash, as a hard link where the filesystem allows and a copy where it does not."""
    source = os.path.normpath(os.path.join(dest, entry["reuse"])) if entry.get("reuse") else None
    if source is None or not os.path.isfile(source) or _sha256(source) != entry["sha256"]:
        return False
    partial = target + ".downloading"
    try:
        os.link(source, partial)
    except OSError:
        import shutil

        shutil.copyfile(source, partial)
    os.replace(partial, target)
    return True


def _download_pinned(dest: str, download: dict[str, Any]) -> None:
    """A model `onnx-asr` has no name for: each file at a pinned commit of a Hugging Face repository,
    checked against its SHA-256, and put in `dest` under the name the loader looks for. A file already
    there with the right hash is kept, so a failed install resumes at the first file not yet complete (a file
    interrupted part-way starts again from its first byte). `download["config"]` becomes `config.json`,
    removed first and written last: a directory holding `config.json` is a complete model, even after a
    failed update."""
    from huggingface_hub import hf_hub_download

    os.makedirs(dest, exist_ok=True)
    staging = os.path.join(dest, ".downloading")
    try:
        if os.path.exists(os.path.join(dest, "config.json")):
            os.remove(os.path.join(dest, "config.json"))
        for entry in download["files"]:
            target = os.path.join(dest, entry["local"])
            if os.path.isfile(target) and _sha256(target) == entry["sha256"]:
                continue
            if _link_existing(dest, target, entry):
                continue
            fetched = hf_hub_download(entry["repo"], entry["remote"], revision=entry["revision"], local_dir=staging)
            found = _sha256(fetched)
            if found != entry["sha256"]:
                raise RuntimeError(f"{entry['remote']} from {entry['repo']} has SHA-256 {found}, expected {entry['sha256']}")
            os.replace(fetched, target)
        partial = os.path.join(dest, "config.json.downloading")
        with open(partial, "w", encoding="utf-8") as out:
            json.dump(download["config"], out)
        os.replace(partial, os.path.join(dest, "config.json"))
    finally:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)


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
