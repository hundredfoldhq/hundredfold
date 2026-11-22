"""Unit tests for the speech sidecar with the models stubbed: `python3 -m unittest`
from this directory. No third-party package is needed."""

import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import threading
import time
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import speech_sidecar as sc  # noqa: E402


class Pipe:
    """A byte pipe the server reads frames from while the test writes more."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._cond = threading.Condition()
        self._closed = False

    def write(self, data: bytes) -> int:
        with self._cond:
            self._buffer += data
            self._cond.notify_all()
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    def read(self, count: int) -> bytes:
        with self._cond:
            while not self._buffer and not self._closed:
                self._cond.wait()
            taken = bytes(self._buffer[:count])
            del self._buffer[:count]
            return taken

    def frames(self) -> list[tuple[dict, bytes]]:
        with self._cond:
            data = io.BytesIO(bytes(self._buffer))
        out = []
        while (frame := sc.read_frame(data)) is not None:
            out.append(frame)
        return out


class StubVad(sc.VadModel):
    """Speech probability comes from the first sample of each window's frame."""

    def new_state(self):
        return None

    def probability(self, window, state):
        sample = struct.unpack_from("<h", window, sc.VAD_CONTEXT_SAMPLES * 2)[0]
        return (1.0 if sample > 0 else 0.0), state


class StubStt(sc.SttModel):
    def __init__(self) -> None:
        self.calls: list[int] = []
        self.gate: threading.Event | None = None

    def recognize(self, pcm: bytes) -> str:
        self.calls.append(len(pcm))
        if self.gate:
            self.gate.wait(5)
        return f"heard {len(pcm)} bytes"


class StubTts(sc.TtsModel):
    voices = ["af_heart", "bf_emma"]

    def __init__(self) -> None:
        self.chunks = 3
        self.after_first = threading.Event()
        self.release = threading.Event()
        self.closed = threading.Event()
        self.fail = False

    def synthesize(self, text, voice, speed, lang):
        try:
            if self.fail:
                raise RuntimeError("voice not found")
            for index in range(self.chunks):
                yield struct.pack("<h", index) * 4, 24000
                if index == 0:
                    self.after_first.set()
                    self.release.wait(5)
        finally:
            self.closed.set()


def frame(header: dict, body: bytes = b"") -> bytes:
    return sc.encode_frame(header, body)


class Harness:
    def __init__(self, loader=None) -> None:
        self.stt, self.tts = StubStt(), StubTts()
        self.inbound, self.outbound = Pipe(), Pipe()
        models = sc.Models(StubVad(), self.stt, self.tts, "cpu")
        self.server = sc.Server(self.inbound, self.outbound, loader or (lambda hello: models))
        self.exit_code: list[int] = []
        self.thread = threading.Thread(target=lambda: self.exit_code.append(self.server.serve()), daemon=True)
        self.thread.start()

    def send(self, header: dict, body: bytes = b"") -> None:
        self.inbound.write(frame(header, body))

    def wait_for(self, predicate, timeout: float = 5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = [f for f in self.outbound.frames() if predicate(f[0])]
            if found:
                return found
            time.sleep(0.01)
        raise AssertionError(f"no matching frame in {self.outbound.frames()}")

    def finish(self) -> list[tuple[dict, bytes]]:
        self.inbound.close()
        self.thread.join(5)
        return self.outbound.frames()


HELLO = {"op": "hello", "device": "auto", "models": {}}


class FramingTests(unittest.TestCase):
    def test_round_trip_with_binary_body(self):
        body = bytes(range(256)) * 5
        raw = sc.encode_frame({"op": "x", "n": 1, "text": "héllo"}, body)
        header, got = sc.read_frame(io.BytesIO(raw))
        self.assertEqual(header, {"op": "x", "n": 1, "text": "héllo"})
        self.assertEqual(got, body)

    def test_empty_body_and_two_frames_in_a_row(self):
        stream = io.BytesIO(sc.encode_frame({"a": 1}) + sc.encode_frame({"b": 2}, b"zz"))
        self.assertEqual(sc.read_frame(stream), ({"a": 1}, b""))
        self.assertEqual(sc.read_frame(stream), ({"b": 2}, b"zz"))
        self.assertIsNone(sc.read_frame(stream))

    def test_maximum_sizes_are_accepted_and_one_over_is_refused(self):
        sc.read_frame(io.BytesIO(sc.encode_frame({"k": "v"}, bytes(sc.MAX_BODY_BYTES))))
        with self.assertRaises(sc.FramingError):
            sc.encode_frame({"k": "v"}, bytes(sc.MAX_BODY_BYTES + 1))
        with self.assertRaises(sc.FramingError):
            sc.encode_frame({"k": "x" * sc.MAX_HEADER_BYTES})
        fits = {"k": "x" * (sc.MAX_HEADER_BYTES - len('{"k":""}'))}
        sc.read_frame(io.BytesIO(sc.encode_frame(fits)))

    def test_oversize_body_is_skipped_so_the_next_frame_stays_aligned(self):
        big = struct.pack(">II", 2, sc.MAX_BODY_BYTES + 1) + b"{}" + bytes(sc.MAX_BODY_BYTES + 1)
        stream = io.BytesIO(big + sc.encode_frame({"after": True}))
        with self.assertRaises(sc.Oversize):
            sc.read_frame(stream)
        self.assertEqual(sc.read_frame(stream), ({"after": True}, b""))

    def test_oversize_header_and_truncated_frames_are_fatal(self):
        with self.assertRaises(sc.FramingError):
            sc.read_frame(io.BytesIO(struct.pack(">II", sc.MAX_HEADER_BYTES + 1, 0)))
        with self.assertRaises(sc.FramingError):
            sc.read_frame(io.BytesIO(sc.encode_frame({"a": 1}, b"abcd")[:-2]))

    def test_a_header_that_is_not_an_object_is_refused_without_losing_place(self):
        raw = struct.pack(">II", 2, 3) + b"[]" + b"abc"
        stream = io.BytesIO(raw + sc.encode_frame({"ok": 1}))
        with self.assertRaises(sc.FramingError):
            sc.read_frame(stream)
        self.assertEqual(sc.read_frame(stream), ({"ok": 1}, b""))


class EndpointerTests(unittest.TestCase):
    def run_probs(self, probs, **kwargs):
        args = dict(threshold=0.5, min_speech_ms=64, silence_ms=96, preroll_ms=0)
        args.update(kwargs)
        endpointer = sc.Endpointer(**args)
        events = []
        for index, p in enumerate(probs):
            events += [(index, event) for event in endpointer.push(p)]
        return events

    def test_start_after_min_speech_and_end_after_silence(self):
        # 32 ms frames: two speech frames confirm; three silent frames end.
        events = self.run_probs([0, 0, 1, 1, 1, 0, 0, 0, 0])
        self.assertEqual([(i, e["kind"]) for i, e in events], [(3, "start"), (7, "end")])
        self.assertEqual(events[0][1]["atMs"], 2 * 32)  # onset: the first speech frame
        self.assertEqual(events[1][1]["atMs"], 5 * 32)  # where the last speech frame ended

    def test_preroll_moves_the_start_back_and_never_below_zero(self):
        events = self.run_probs([0, 0, 1, 1], preroll_ms=40)
        self.assertEqual(events[0][1]["atMs"], 64 - 40)
        self.assertEqual(self.run_probs([1, 1], preroll_ms=500)[0][1]["atMs"], 0)

    def test_a_blip_shorter_than_min_speech_is_ignored(self):
        self.assertEqual(self.run_probs([0, 1, 0, 0, 1, 0, 0]), [])

    def test_a_short_dip_inside_speech_does_not_end_it(self):
        self.assertEqual([e["kind"] for _, e in self.run_probs([1, 1, 0, 0, 1, 1, 0, 1])], ["start"])

    def test_hysteresis_keeps_speech_between_the_two_thresholds(self):
        # 0.4 is under the 0.5 start threshold but over the 0.35 stay threshold.
        events = self.run_probs([1, 1, 0.4, 0.4, 0.4, 0.4, 0.4])
        self.assertEqual([e["kind"] for _, e in events], ["start"])

    def test_a_second_utterance_starts_again(self):
        events = self.run_probs([1, 1, 0, 0, 0, 1, 1, 0, 0, 0])
        self.assertEqual([e["kind"] for _, e in events], ["start", "end", "start", "end"])


class VadStreamTests(unittest.TestCase):
    def frames_of(self, sample: int, count: int) -> bytes:
        return struct.pack("<h", sample) * (sc.VAD_FRAME_SAMPLES * count)

    def test_audio_split_across_writes_is_framed_and_context_carried(self):
        stream = sc.VadStream(StubVad(), sc.Endpointer(0.5, 64, 96, 0))
        audio = self.frames_of(1000, 2) + self.frames_of(0, 3)
        events = []
        for start in range(0, len(audio), 700):  # odd chunking, mid-frame
            events += stream.write(audio[start : start + 700])
        self.assertEqual([e["kind"] for e in events], ["start", "end"])


class ServerTests(unittest.TestCase):
    def test_hello_loads_models_and_reports_ready(self):
        h = Harness()
        h.send(HELLO)
        (ready, _), = h.wait_for(lambda f: f["op"] == "ready")
        self.assertEqual(ready, {"op": "ready", "device": "cpu", "voices": ["af_heart", "bf_emma"], "sttPartials": True})
        h.finish()

    def test_hello_failure_is_an_error_not_a_crash(self):
        def broken(_):
            raise RuntimeError("no model files")

        h = Harness(broken)
        h.send(HELLO)
        (err, _), = h.wait_for(lambda f: f["op"] == "error")
        self.assertEqual(err["ref"], "hello")
        self.assertIn("no model files", err["message"])
        h.send({"op": "ping", "n": 1})
        h.wait_for(lambda f: f["op"] == "pong")
        h.finish()

    def test_unknown_op_answers_error_and_the_server_carries_on(self):
        h = Harness()
        h.send({"op": "nope", "id": "q1"})
        (err, _), = h.wait_for(lambda f: f["op"] == "error")
        self.assertEqual((err["ref"], "nope" in err["message"]), ("q1", True))
        h.send({"op": "ping", "n": 7})
        (pong, _), = h.wait_for(lambda f: f["op"] == "pong")
        self.assertEqual(pong["n"], 7)
        self.assertEqual(h.finish()[-1][0]["op"], "pong")

    def test_ops_before_hello_are_refused(self):
        h = Harness()
        h.send({"op": "tts", "id": "t1", "text": "hi"})
        (err, _), = h.wait_for(lambda f: f["op"] == "error")
        self.assertIn("hello", err["message"])
        h.finish()

    def test_vad_events_carry_the_stream(self):
        h = Harness()
        h.send(HELLO)
        h.send({"op": "vad.open", "stream": "s1", "threshold": 0.5, "minSpeechMs": 64, "silenceMs": 96, "prerollMs": 0})
        h.send({"op": "vad.audio", "stream": "s1"}, struct.pack("<h", 900) * (sc.VAD_FRAME_SAMPLES * 2))
        (start, _), = h.wait_for(lambda f: f["op"] == "vad.event")
        self.assertEqual((start["stream"], start["kind"]), ("s1", "start"))
        h.send({"op": "vad.audio", "stream": "s1"}, bytes(sc.VAD_FRAME_SAMPLES * 2 * 3))
        h.wait_for(lambda f: f["op"] == "vad.event" and f["kind"] == "end")
        h.send({"op": "vad.close", "stream": "s1"})
        h.send({"op": "vad.audio", "stream": "s1"}, bytes(10))
        h.wait_for(lambda f: f["op"] == "error" and f["ref"] == "s1")
        h.finish()

    def test_audio_for_an_unknown_vad_stream_is_reported_once_not_per_frame(self):
        h = Harness()
        h.send(HELLO)
        for _ in range(50):
            h.send({"op": "vad.audio", "stream": "lost"}, bytes(640))
        h.send({"op": "ping", "n": 1})
        h.wait_for(lambda f: f["op"] == "pong")
        errors = [f for f, _ in h.outbound.frames() if f["op"] == "error" and f["ref"] == "lost"]
        self.assertEqual(len(errors), 1)
        h.finish()

    def test_a_stt_error_says_which_kind_of_decode_failed(self):
        h = Harness()
        h.send(HELLO)

        def broken(pcm):
            raise RuntimeError("decode exploded")

        h.stt.recognize = broken
        h.send({"op": "stt.partial", "stream": "s", "utterance": "u1"}, bytes(10))
        (err, _), = h.wait_for(lambda f: f["op"] == "error" and f["ref"] == "u1")
        self.assertIs(err["final"], False)
        h.send({"op": "stt.final", "stream": "s", "utterance": "u2"}, bytes(10))
        (err2, _), = h.wait_for(lambda f: f["op"] == "error" and f["ref"] == "u2")
        self.assertIs(err2["final"], True)
        h.finish()

    def test_stt_partial_and_final_reply_with_their_utterance(self):
        h = Harness()
        h.send(HELLO)
        h.send({"op": "stt.partial", "stream": "s", "utterance": "u1"}, bytes(1000))
        h.send({"op": "stt.final", "stream": "s", "utterance": "u1"}, bytes(2000))
        replies = [f for f in h.wait_for(lambda f: f["op"] == "stt.text" and f["final"])]
        self.assertEqual(replies[0][0]["text"], "heard 2000 bytes")
        texts = [(f["text"], f["final"]) for f, _ in h.outbound.frames() if f["op"] == "stt.text"]
        self.assertEqual(texts, [("heard 1000 bytes", False), ("heard 2000 bytes", True)])
        h.finish()

    def test_replies_come_back_in_completion_order_with_their_own_ids(self):
        h = Harness()
        h.send(HELLO)
        h.stt.gate = threading.Event()
        h.send({"op": "stt.final", "stream": "s", "utterance": "slow"}, bytes(10))  # blocks in the model
        h.send({"op": "tts", "id": "fast", "text": "hi", "voice": "af_heart", "speed": 1, "lang": "en"})
        h.tts.release.set()
        h.wait_for(lambda f: f["op"] == "tts.done" and f["id"] == "fast")
        self.assertFalse([f for f, _ in h.outbound.frames() if f["op"] == "stt.text"])  # not yet
        h.stt.gate.set()
        (late, _), = h.wait_for(lambda f: f["op"] == "stt.text")
        self.assertEqual(late["utterance"], "slow")
        order = [f.get("id") or f.get("utterance") for f, _ in h.outbound.frames() if f["op"] in ("tts.done", "stt.text")]
        self.assertEqual(order, ["fast", "slow"])
        h.finish()

    def test_tts_streams_chunks_then_done(self):
        h = Harness()
        h.send(HELLO)
        h.tts.release.set()
        h.send({"op": "tts", "id": "t1", "text": "hello", "voice": "af_heart", "speed": 1, "lang": "en"})
        h.wait_for(lambda f: f["op"] == "tts.done")
        frames = [f for f in h.outbound.frames() if f[0].get("id") == "t1"]
        self.assertEqual([f["op"] for f, _ in frames], ["tts.audio"] * 3 + ["tts.done"])
        self.assertEqual({f["sampleRate"] for f, _ in frames if f["op"] == "tts.audio"}, {24000})
        self.assertEqual(frames[0][1], struct.pack("<h", 0) * 4)
        h.finish()

    def test_cancel_stops_a_tts_mid_stream_and_nothing_more_is_sent_for_it(self):
        h = Harness()
        h.send(HELLO)
        h.tts.chunks = 50
        h.send({"op": "tts", "id": "t1", "text": "a long sentence", "voice": "af_heart", "speed": 1, "lang": "en"})
        self.assertTrue(h.tts.after_first.wait(5))
        h.send({"op": "cancel", "id": "t1"})
        h.send({"op": "ping", "n": 1})
        h.wait_for(lambda f: f["op"] == "pong")  # the cancel before it has been handled
        h.tts.release.set()
        self.assertTrue(h.tts.closed.wait(5), "the synthesis generator was not closed")
        h.send({"op": "ping", "n": 2})
        h.wait_for(lambda f: f["op"] == "pong" and f["n"] == 2)
        frames = [f for f, _ in h.outbound.frames() if f.get("id") == "t1"]
        self.assertLessEqual(len(frames), 1)
        self.assertNotIn("tts.done", [f["op"] for f in frames])
        h.finish()

    def test_cancel_drops_the_reply_of_a_decode_already_running(self):
        h = Harness()
        h.send(HELLO)
        h.stt.gate = threading.Event()
        h.send({"op": "stt.final", "stream": "s", "utterance": "u9"}, bytes(10))
        while not h.stt.calls:
            time.sleep(0.01)
        h.send({"op": "cancel", "id": "u9"})
        h.send({"op": "ping", "n": 1})
        h.wait_for(lambda f: f["op"] == "pong")
        h.stt.gate.set()
        h.send({"op": "ping", "n": 2})
        h.wait_for(lambda f: f["op"] == "pong" and f["n"] == 2)
        self.assertFalse([f for f, _ in h.outbound.frames() if f["op"] == "stt.text"])
        h.finish()

    def test_a_failing_synthesis_answers_error_for_that_request_only(self):
        h = Harness()
        h.send(HELLO)
        h.tts.fail = True
        h.send({"op": "tts", "id": "bad", "text": "x"})
        (err, _), = h.wait_for(lambda f: f["op"] == "error" and f["ref"] == "bad")
        self.assertIn("voice not found", err["message"])
        h.send({"op": "ping", "n": 3})
        h.wait_for(lambda f: f["op"] == "pong")
        h.finish()

    def test_an_oversize_body_answers_error_and_the_next_request_still_works(self):
        h = Harness()
        h.send(HELLO)
        h.inbound.write(struct.pack(">II", 2 + 0, sc.MAX_BODY_BYTES + 1) + b'{}' + bytes(sc.MAX_BODY_BYTES + 1))
        h.send({"op": "ping", "n": 5})
        h.wait_for(lambda f: f["op"] == "error")
        h.wait_for(lambda f: f["op"] == "pong" and f["n"] == 5)
        h.finish()

    def test_end_of_input_ends_the_server_cleanly(self):
        h = Harness()
        h.finish()
        self.assertEqual(h.exit_code, [0])

    def test_a_bad_frame_ends_the_server_with_an_error_exit(self):
        h = Harness()
        h.inbound.write(struct.pack(">II", sc.MAX_HEADER_BYTES + 1, 0))
        h.thread.join(5)
        self.assertEqual(h.exit_code, [2])


class LanguageTests(unittest.TestCase):
    def test_kokoro_language_follows_the_voice_for_english(self):
        self.assertEqual(sc.kokoro_language("af_heart", "en"), "en-us")
        self.assertEqual(sc.kokoro_language("bf_emma", "en-GB"), "en-gb")
        self.assertEqual(sc.kokoro_language("ff_siwis", "fr-fr"), "fr-fr")


class PinnedDownloadTests(unittest.TestCase):
    """The download of a model `onnx-asr` has no name for: pinned files, checked by hash, renamed for the loader."""

    CONTENT = {"x/enc.onnx": b"graph", "x/enc.onnx.data": b"weights", "vocab.txt": b"a 0\n"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = os.path.join(self.tmp.name, "model")
        self.fetched: list[tuple[str, str, str]] = []
        outer = self

        def hf_hub_download(repo, filename, revision=None, local_dir=None):
            outer.fetched.append((repo, filename, revision))
            path = os.path.join(local_dir, filename)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as out:
                out.write(outer.CONTENT[filename])
            return path

        self._saved = sys.modules.get("huggingface_hub")
        sys.modules["huggingface_hub"] = types.SimpleNamespace(hf_hub_download=hf_hub_download)
        self.addCleanup(self.restore)

    def restore(self):
        self.tmp.cleanup()
        if self._saved is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self._saved

    def download(self, **overrides):
        files = [
            {"repo": "o/r", "revision": "abc", "remote": remote, "local": local, "sha256": hashlib.sha256(self.CONTENT[remote]).hexdigest()}
            for remote, local in (("x/enc.onnx", "encoder-model.onnx"), ("x/enc.onnx.data", "enc.onnx.data"), ("vocab.txt", "vocab.txt"))
        ]
        return {"files": files, "config": {"model_type": "nemo-conformer-rnnt"}, **overrides}

    def test_files_land_under_the_loader_names_with_a_config_and_no_leftovers(self):
        sc._download_pinned(self.dest, self.download())
        self.assertEqual(sorted(os.listdir(self.dest)), ["config.json", "enc.onnx.data", "encoder-model.onnx", "vocab.txt"])
        self.assertEqual(open(os.path.join(self.dest, "encoder-model.onnx"), "rb").read(), b"graph")
        self.assertEqual(json.load(open(os.path.join(self.dest, "config.json"))), {"model_type": "nemo-conformer-rnnt"})
        self.assertEqual(self.fetched[0], ("o/r", "x/enc.onnx", "abc"))

    def test_a_file_with_the_wrong_hash_fails_the_install_and_is_not_kept(self):
        spec = self.download()
        spec["files"][1]["sha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "x/enc.onnx.data from o/r has SHA-256"):
            sc._download_pinned(self.dest, spec)
        self.assertFalse(os.path.exists(os.path.join(self.dest, "enc.onnx.data")))
        self.assertFalse(os.path.exists(os.path.join(self.dest, "config.json")))  # not a loadable model
        self.assertFalse(os.path.exists(os.path.join(self.dest, ".downloading")))

    def test_files_already_there_with_the_right_hash_are_not_fetched_again(self):
        sc._download_pinned(self.dest, self.download())
        self.fetched.clear()
        sc._download_pinned(self.dest, self.download())
        self.assertEqual(self.fetched, [])

    def test_an_update_that_fails_part_way_leaves_no_config_behind(self):
        sc._download_pinned(self.dest, self.download())
        spec = self.download()
        spec["files"][2]["sha256"] = "0" * 64  # a new pin whose file does not match
        spec["files"][0]["sha256"] = "1" * 64  # and the old file no longer counts as the pinned one
        with self.assertRaises(RuntimeError):
            sc._download_pinned(self.dest, spec)
        self.assertFalse(os.path.exists(os.path.join(self.dest, "config.json")))  # so the half-updated directory is not loaded

    def test_a_damaged_file_is_fetched_again(self):
        sc._download_pinned(self.dest, self.download())
        with open(os.path.join(self.dest, "encoder-model.onnx"), "wb") as out:
            out.write(b"half")
        self.fetched.clear()
        sc._download_pinned(self.dest, self.download())
        self.assertEqual([name for _, name, _ in self.fetched], ["x/enc.onnx"])
        self.assertEqual(open(os.path.join(self.dest, "encoder-model.onnx"), "rb").read(), b"graph")

    def test_download_with_a_pinned_stt_runs_only_the_steps_asked_for(self):
        spec = {"stt": {"name": "nemo-conformer-rnnt", "path": self.dest, "quantization": None, "download": self.download()}, "only": ["stt"]}
        out = io.StringIO()
        saved, sys.stdout = sys.stdout, out
        try:
            self.assertEqual(sc.download(spec), 0)
        finally:
            sys.stdout = saved
        steps = [json.loads(line)["step"] for line in out.getvalue().splitlines()]
        self.assertEqual(steps, ["stt", "done"])  # no vad, no kokoro
        self.assertTrue(os.path.isfile(os.path.join(self.dest, "config.json")))


if __name__ == "__main__":
    unittest.main()
