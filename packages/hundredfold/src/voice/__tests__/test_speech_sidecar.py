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
from unittest import mock

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


class FrameEngine(sc.StreamEngine):
    """Encoder frame k of the audio is the value k + 1: every sample in frame k's 1,280-sample span holds it. The
    model 'hears' one token per frame, so a streaming decode is right exactly when it emits every frame once, in order.
    A window cut at a sample that is not a frame boundary (the last step trims by however many samples it was over) moves
    the stub's frame grid, which a real model shrugs off; the tests keep the cuts on frame boundaries."""

    left_frames, chunk_frames, right_frames, subsampling = 40, 16, 24, 8  # 5, 2 and 3 encoder frames
    blank, max_tokens = 0, 4
    span = 160 * 8

    def __init__(self) -> None:
        self.windows: list[int] = []  # samples in each window the encoder saw

    def encode(self, window):
        self.windows.append(len(window) // 2)
        samples = struct.unpack(f"<{len(window) // 2}h", window)
        return [samples[at] for at in range(0, len(samples), self.span)], -(-len(samples) // self.span)

    def new_state(self):
        return 0

    def step(self, tokens, state, frame):
        # One token per frame, then the blank, as a joint does after it has spoken for a frame. The decoder state is the
        # number of tokens it has taken in, as an RNN-T's prediction network's is: a state that was dropped or replayed
        # between steps no longer matches the tokens, and the stub says so by speaking garbage.
        if tokens and tokens[-1] == frame:
            return self.blank, state
        return (frame if state == len(tokens) else -1), state + 1

    def text(self, tokens):
        return ",".join(str(t) for t in tokens)


def frames_pcm(frames: int, tail: int = 0) -> bytes:
    """`frames` whole frames of the FrameEngine's audio, then `tail` samples of the next frame."""
    out = b"".join(struct.pack("<h", k + 1) * FrameEngine.span for k in range(frames))
    return out + struct.pack("<h", frames + 1) * tail


def expected_text(frames: int, tail: int = 0) -> str:
    return ",".join(str(k + 1) for k in range(frames + (1 if tail else 0)))


class StreamingUtteranceTests(unittest.TestCase):
    def run_schedule(self, frames: int, tail: int, cuts: list[int]) -> tuple[str, FrameEngine, list[str]]:
        engine = FrameEngine()
        utterance = sc.StreamingUtterance(engine)
        pcm = frames_pcm(frames, tail)
        partials = [utterance.advance(pcm[: cut * 2], False) for cut in cuts]
        return utterance.advance(pcm, True), engine, partials

    def test_the_final_text_is_the_same_whatever_the_partials_did(self):
        for frames, tail in [(0, 700), (1, 0), (3, 17), (6, 0), (7, 1), (12, 0), (25, 0), (40, 0)]:
            total = frames * FrameEngine.span + tail
            for cuts in ([], [total // 2], list(range(500, total, 500)), list(range(1280, total, 1280)), list(range(1, total, 4001))):
                with self.subTest(frames=frames, tail=tail, partials=len(cuts)):
                    text, _, _ = self.run_schedule(frames, tail, cuts)
                    self.assertEqual(text, expected_text(frames, tail))

    def test_the_decoder_state_is_carried_between_requests_and_across_window_slides(self):
        # 40 frames slide the window many times (it holds 10); the partials cut the utterance at chunk and mid-chunk points.
        engine = FrameEngine()
        utterance = sc.StreamingUtterance(engine)
        pcm = frames_pcm(40)
        total = 40 * FrameEngine.span
        for cut in range(3000, total, 3000):
            text = utterance.advance(pcm[: cut * 2], False)
            self.assertNotIn("-1", text.split(","), f"state lost by the partial at {cut}")
            self.assertEqual(utterance.state, len(utterance.tokens), f"state out of step with the tokens at {cut}")
        self.assertEqual(utterance.advance(pcm, True), expected_text(40))
        self.assertEqual(utterance.state, 40)
        utterance.advance(frames_pcm(3), True)  # shorter audio for the same utterance starts it over, state included
        self.assertEqual(utterance.state, 3)

    def test_a_partial_holds_back_only_what_still_lacks_right_context(self):
        # Five frames of audio: the first step needs a chunk and the right context (5 frames), so exactly 2 are decoded.
        _, _, partials = self.run_schedule(5, 0, [5 * FrameEngine.span])
        self.assertEqual(partials, ["1,2"])

    def test_work_is_incremental_not_a_redecode_of_the_buffer(self):
        engine = FrameEngine()
        utterance = sc.StreamingUtterance(engine)
        pcm = frames_pcm(60)
        span = FrameEngine.span
        calls = []
        for frames in range(5, 61):
            utterance.advance(pcm[: frames * span * 2], False)
            calls.append(len(engine.windows))
        self.assertLessEqual(max(b - a for a, b in zip(calls, calls[1:])), 1, "one new frame never costs more than one step")
        before = len(engine.windows)
        utterance.advance(pcm, True)
        self.assertLessEqual(len(engine.windows) - before, 2, "a final after partials decodes only the tail")
        self.assertLessEqual(max(engine.windows), engine.left_frames * 160 + (engine.chunk_frames + engine.right_frames) * 160, "the window never outgrows left + chunk + right")

    def test_a_final_with_no_partials_decodes_everything(self):
        text, engine, _ = self.run_schedule(20, 0, [])
        self.assertEqual(text, expected_text(20))
        self.assertGreater(len(engine.windows), 2)

    def test_a_buffer_that_shrinks_starts_over(self):
        engine = FrameEngine()
        utterance = sc.StreamingUtterance(engine)
        utterance.advance(frames_pcm(12), False)
        self.assertEqual(utterance.advance(frames_pcm(6), True), expected_text(6))

    def test_an_empty_utterance_decodes_to_nothing(self):
        engine = FrameEngine()
        self.assertEqual(sc.StreamingUtterance(engine).advance(b"", True), "")
        self.assertEqual(engine.windows, [])

    def test_a_token_cap_per_frame_bounds_a_runaway_joint(self):
        engine = FrameEngine()
        engine.step = lambda tokens, state, frame: (7, state)  # never blank
        self.assertEqual(sc.StreamingUtterance(engine).advance(frames_pcm(1), True), "7,7,7,7")


class StreamingSttTests(unittest.TestCase):
    def test_utterances_keep_separate_state_and_the_final_drops_it(self):
        stt = sc.StreamingStt(FrameEngine())
        pcm = frames_pcm(9)
        stt.transcribe("a", pcm[: 5 * FrameEngine.span * 2], False)
        stt.transcribe("b", pcm[: 8 * FrameEngine.span * 2], False)
        self.assertEqual(set(stt._streams), {"a", "b"})
        self.assertEqual(stt.transcribe("a", pcm, True), expected_text(9))
        self.assertEqual(set(stt._streams), {"b"})
        stt.forget("b")
        stt.forget("never-seen")
        self.assertEqual(stt._streams, {})

    def test_a_failed_step_drops_the_state_so_the_next_request_starts_over(self):
        engine = FrameEngine()
        stt = sc.StreamingStt(engine)
        pcm = frames_pcm(9)
        stt.transcribe("u", pcm[: 6 * FrameEngine.span * 2], False)
        real = engine.encode
        engine.encode = lambda window: (_ for _ in ()).throw(RuntimeError("device lost"))
        with self.assertRaises(RuntimeError):
            stt.transcribe("u", pcm, False)
        self.assertNotIn("u", stt._streams)
        engine.encode = real
        self.assertEqual(stt.transcribe("u", pcm, True), expected_text(9))

    def test_abandoned_utterances_are_capped(self):
        stt = sc.StreamingStt(FrameEngine())
        for n in range(sc.MAX_STREAMS + 5):
            stt.transcribe(f"u{n}", frames_pcm(6), False)
        self.assertEqual(len(stt._streams), sc.MAX_STREAMS)
        self.assertIn(f"u{sc.MAX_STREAMS + 4}", stt._streams)
        self.assertNotIn("u0", stt._streams)

    def test_stateless_recognize_and_warm_work(self):
        stt = sc.StreamingStt(FrameEngine())
        self.assertEqual(stt.recognize(frames_pcm(8)), expected_text(8))
        stt.warm()
        self.assertEqual(stt._streams, {})

    def test_a_request_marks_its_utterance_as_recently_used_so_a_live_one_outlasts_abandoned_ones(self):
        stt = sc.StreamingStt(FrameEngine())
        pcm = frames_pcm(14)
        stt.transcribe("live", pcm[: 6 * FrameEngine.span * 2], False)
        for n in range(sc.MAX_STREAMS - 1):
            stt.transcribe(f"abandoned{n}", frames_pcm(6), False)
        self.assertEqual(len(stt._streams), sc.MAX_STREAMS)
        stt.transcribe("live", pcm[: 9 * FrameEngine.span * 2], False)  # a partial: "live" is now the newest, not the oldest
        for n in range(3):
            stt.transcribe(f"newcomer{n}", frames_pcm(6), False)
        self.assertIn("live", stt._streams, "the utterance still being spoken is not the one dropped")
        self.assertNotIn("abandoned0", stt._streams)
        self.assertNotIn("abandoned2", stt._streams)
        self.assertEqual(stt.transcribe("live", pcm, True), expected_text(14), "and it kept its decoder state")

    def test_warm_walks_the_encoder_through_every_window_size_and_keeps_nothing(self):
        engine = FrameEngine()
        stt = sc.StreamingStt(engine)
        fed: list[int] = []
        recognize = stt.recognize
        stt.recognize = lambda pcm: (fed.append(len(pcm) // 2), recognize(pcm))[1]
        stt.warm()
        # The model the sidecar loads has 560 feature frames of left context, 56 of chunk and 56 of right: its window is full after
        # about 6.7 s, and every size before that is one the encoder sees on the way.
        self.assertGreaterEqual(fed[0], (560 + 56 + 56) * sc.STREAM_HOP, "enough audio to fill the real model's window")
        capacity = (FrameEngine.left_frames + FrameEngine.chunk_frames + FrameEngine.right_frames) * sc.STREAM_HOP
        first = (FrameEngine.chunk_frames + FrameEngine.right_frames) * sc.STREAM_HOP
        chunk = FrameEngine.chunk_frames * sc.STREAM_HOP
        self.assertEqual(sorted(set(engine.windows)), [first, first + chunk, first + 2 * chunk, capacity], "a window grows a chunk at a time from its first size to its full one, so every shape the encoder will see is seen")
        self.assertEqual(stt._streams, {}, "nothing is held for an utterance that never existed")

    def test_the_server_decodes_partials_and_final_through_the_utterance_state_and_cancel_forgets_it(self):
        h = Harness()
        stt = sc.StreamingStt(FrameEngine())
        h.server._loader = lambda hello: sc.Models(StubVad(), stt, h.tts, "cpu")
        h.send(HELLO)
        pcm = frames_pcm(14)
        h.send({"op": "stt.partial", "stream": "s", "utterance": "u1"}, pcm[: 8 * FrameEngine.span * 2])
        h.send({"op": "stt.partial", "stream": "s", "utterance": "u2"}, pcm[: 8 * FrameEngine.span * 2])
        h.send({"op": "stt.final", "stream": "s", "utterance": "u1"}, pcm)
        h.wait_for(lambda f: f["op"] == "stt.text" and f["final"])
        h.send({"op": "cancel", "id": "u2"})
        h.send({"op": "ping", "n": 1})
        h.wait_for(lambda f: f["op"] == "pong")
        texts = {(f["utterance"], f["final"]): f["text"] for f, _ in h.outbound.frames() if f["op"] == "stt.text"}
        self.assertEqual(texts[("u1", True)], expected_text(14))
        self.assertEqual(texts[("u1", False)], "1,2,3,4")
        self.assertEqual(stt._streams, {})
        h.finish()


try:
    import numpy as np
except ImportError:  # the stubs above need no packages; this one fake does
    np = None


class FakeOnnxAsr:
    """The corners of an `onnx-asr` NeMo RNN-T model that the streaming engine reaches into."""

    _blank_idx = 1024
    _max_tokens_per_step = 10

    def __init__(self, meta=None) -> None:
        self.calls: list[tuple[int, int]] = []
        metadata = meta if meta is not None else {
            "streaming_model_type": "nemo_parakeet_unified_streaming", "left_feature_frames": "560", "chunk_feature_frames": "56",
            "right_feature_frames": "56", "subsampling_factor": "8",
        }
        self._encoder = types.SimpleNamespace(get_modelmeta=lambda: types.SimpleNamespace(custom_metadata_map=metadata))

    def _preprocessor(self, waveforms, lengths):
        self.calls.append((waveforms.shape[1], int(lengths[0])))
        return waveforms, lengths

    def _encode(self, features, lengths):
        return features.reshape(1, -1, 1), lengths // 160 // 8

    def _create_state(self):
        return None

    def _decode(self, tokens, state, frame):
        return np.zeros(1025), -1, state

    def _decode_tokens(self, ids, indices, logprobs):
        return types.SimpleNamespace(text=" ".join(str(i) for i in ids))


@unittest.skipIf(np is None, "numpy is not installed")
class OnnxAsrStreamEngineTests(unittest.TestCase):
    WINDOW = (560 + 56 + 56) * 160

    def pcm(self, samples: int) -> bytes:
        return bytes(samples * 2)

    def test_it_reads_the_window_geometry_from_the_encoder(self):
        engine = sc.OnnxAsrStreamEngine(FakeOnnxAsr(), np, True)
        self.assertEqual((engine.left_frames, engine.chunk_frames, engine.right_frames, engine.subsampling), (560, 56, 56, 8))
        self.assertEqual((engine.blank, engine.max_tokens), (1024, 10))

    def test_on_the_gpu_every_window_has_one_shape_and_the_real_length(self):
        asr = FakeOnnxAsr()
        engine = sc.OnnxAsrStreamEngine(asr, np, True)
        for samples in (17920, 26880, 93680, self.WINDOW, 100):
            engine.encode(self.pcm(samples))
        self.assertEqual([shape for shape, _ in asr.calls], [self.WINDOW] * 5, "one input shape, so the graph is planned once")
        self.assertEqual([length for _, length in asr.calls], [17920, 26880, 93680, self.WINDOW, sc.MIN_STT_SAMPLES], "the real length, never below the minimum")

    def test_on_the_cpu_windows_keep_their_length(self):
        asr = FakeOnnxAsr()
        engine = sc.OnnxAsrStreamEngine(asr, np, False)
        engine.encode(self.pcm(17920))
        engine.encode(self.pcm(100))
        self.assertEqual(asr.calls, [(17920, 17920), (sc.MIN_STT_SAMPLES, sc.MIN_STT_SAMPLES)])

    def test_an_encoder_that_is_not_a_streaming_export_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "not a Parakeet Unified streaming export"):
            sc.OnnxAsrStreamEngine(FakeOnnxAsr({}), np, True)

    def test_a_model_object_without_the_expected_internals_is_refused_by_name(self):
        asr = FakeOnnxAsr()
        del FakeOnnxAsr._decode_tokens
        try:
            with self.assertRaisesRegex(RuntimeError, "no _decode_tokens"):
                sc.OnnxAsrStreamEngine(asr, np, True)
        finally:
            FakeOnnxAsr._decode_tokens = lambda self, ids, indices, logprobs: types.SimpleNamespace(text=" ".join(str(i) for i in ids))

    def test_a_token_step_and_the_text_go_through_the_model(self):
        engine = sc.OnnxAsrStreamEngine(FakeOnnxAsr(), np, True)
        self.assertEqual(engine.step([], None, None), (0, None))
        self.assertEqual(engine.text([3, 4]), "3 4")


class FakeOfflineAsr:
    """The corner of an `onnx-asr` model that offline recognition calls: the adapter's `recognize` and the model's `recognize_batch`."""

    def __init__(self) -> None:
        self.batches: list[tuple[int, int]] = []  # (samples in the input, the real length passed) for each batched call
        self.plain: list[int] = []
        self.failure: Exception | None = None
        self.asr = self

    def recognize(self, samples, sample_rate=16000):
        if self.failure:
            raise self.failure
        self.plain.append(samples.size)
        return f"plain {samples.size}"

    def recognize_batch(self, waveforms, lengths):
        if self.failure:
            raise self.failure
        self.batches.append((waveforms.shape[1], int(lengths[0])))
        yield types.SimpleNamespace(text=f" real {int(lengths[0])} ")


@unittest.skipIf(np is None, "numpy is not installed")
class ParakeetOnnxTests(unittest.TestCase):
    def build(self, providers):
        fake = FakeOfflineAsr()
        module = types.SimpleNamespace(load_model=lambda *args, **kwargs: fake)
        with mock.patch.dict(sys.modules, {"onnx_asr": module}):
            model = sc.ParakeetOnnx({"name": "nemo-conformer-rnnt", "path": "/nowhere"}, providers)
        return model, fake

    def seconds(self, value: float) -> bytes:
        return bytes(int(value * sc.VAD_SAMPLE_RATE) * 2)

    def test_on_the_gpu_an_utterance_is_padded_to_a_few_lengths_and_keeps_its_real_one(self):
        model, fake = self.build(["CUDAExecutionProvider", "CPUExecutionProvider"])
        lengths = (0.2, 0.5, 1.7, 3.0, 4.0, 4.3, 7.9, 10.5, 15.2, 20.0, 31.9)
        texts = [model.recognize(self.seconds(value)) for value in lengths]
        rate = sc.VAD_SAMPLE_RATE
        self.assertEqual([padded for padded, _ in fake.batches], [4 * rate] * 5 + [8 * rate] * 2 + [12 * rate, 16 * rate, 24 * rate, 32 * rate], "few shapes, so the graph is planned a few times, not once per length")
        self.assertEqual([real for _, real in fake.batches], [max(int(value * rate), sc.MIN_STT_SAMPLES) for value in lengths], "the real length, never below the minimum")
        self.assertEqual(texts[3], f"real {3 * rate}", "the text is what the model returns for the real length, stripped")
        self.assertEqual(fake.plain, [])

    def test_on_the_gpu_a_longer_utterance_keeps_its_own_length(self):
        model, fake = self.build(["CUDAExecutionProvider"])
        model.recognize(self.seconds(40))
        model.recognize(self.seconds(125))
        self.assertEqual(fake.batches, [(40 * sc.VAD_SAMPLE_RATE, 40 * sc.VAD_SAMPLE_RATE), (125 * sc.VAD_SAMPLE_RATE,) * 2])

    def test_on_the_cpu_audio_is_not_padded(self):
        model, fake = self.build(["CPUExecutionProvider"])
        self.assertEqual(model.recognize(self.seconds(3)), f"plain {3 * sc.VAD_SAMPLE_RATE}")
        self.assertEqual(model.recognize(self.seconds(0.1)), f"plain {sc.MIN_STT_SAMPLES}")
        self.assertEqual(fake.batches, [])

    def test_warm_decodes_once_at_each_padded_length_on_the_gpu_and_once_on_the_cpu(self):
        model, fake = self.build(["CUDAExecutionProvider"])
        model.warm()
        self.assertEqual([padded for padded, _ in fake.batches], [seconds * sc.VAD_SAMPLE_RATE for seconds in sc.OFFLINE_PAD_SECONDS])
        model, fake = self.build(["CPUExecutionProvider"])
        model.warm()
        self.assertEqual(fake.plain, [sc.MIN_STT_SAMPLES])

    def test_running_out_of_gpu_memory_is_reported_as_that_and_other_failures_pass_through(self):
        model, fake = self.build(["CUDAExecutionProvider"])
        for message in (
            "Non-zero status code returned while running Conv node. bfc_arena.cc:360 Failed to allocate memory for requested buffer of size 27346944",
            "CUBLAS failure 3: CUBLAS_STATUS_ALLOC_FAILED ; GPU=0 ; hostname=x ; expr=cublasGemmEx",
            "CUDA failure 2: out of memory ; GPU=0",
        ):
            with self.subTest(message=message):
                fake.failure = RuntimeError(message)
                with self.assertRaisesRegex(RuntimeError, r"GPU ran out of memory on 55 s of audio"):
                    model.recognize(self.seconds(55))
        fake.failure = ValueError("bad input")
        with self.assertRaisesRegex(ValueError, "bad input"):
            model.recognize(self.seconds(3))

    def test_the_cpu_path_reports_its_own_errors_unchanged(self):
        model, fake = self.build(["CPUExecutionProvider"])
        fake.failure = RuntimeError("std::bad_alloc: out of memory")
        with self.assertRaisesRegex(RuntimeError, r"^std::bad_alloc: out of memory$"):
            model.recognize(self.seconds(2))


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

    def reuse_download(self, reuse: str):
        spec = self.download()
        spec["files"][1]["reuse"] = reuse
        return spec

    def sibling(self, content: bytes = b"weights") -> str:
        """Another model's directory holding the weights under the name the offline export gave them."""
        other = os.path.join(self.tmp.name, "other")
        os.makedirs(other)
        with open(os.path.join(other, "weights.data"), "wb") as out:
            out.write(content)
        return os.path.join(other, "weights.data")

    def test_a_file_another_model_already_holds_is_linked_in_not_fetched(self):
        source = self.sibling()
        sc._download_pinned(self.dest, self.reuse_download("../other/weights.data"))
        self.assertEqual([name for _, name, _ in self.fetched], ["x/enc.onnx", "vocab.txt"])
        target = os.path.join(self.dest, "enc.onnx.data")
        self.assertEqual(open(target, "rb").read(), b"weights")
        self.assertTrue(os.path.samefile(source, target), "linked, not a second copy on disk")
        self.assertEqual(sorted(os.listdir(self.dest)), ["config.json", "enc.onnx.data", "encoder-model.onnx", "vocab.txt"])

    def test_a_file_that_is_not_where_the_hint_says_or_has_another_hash_is_fetched(self):
        sc._download_pinned(self.dest, self.reuse_download("../other/missing.data"))
        self.assertIn("x/enc.onnx.data", [name for _, name, _ in self.fetched])
        self.fetched.clear()
        self.sibling(b"something else")
        sc._download_pinned(os.path.join(self.tmp.name, "model2"), self.reuse_download("../other/weights.data"))
        self.assertIn("x/enc.onnx.data", [name for _, name, _ in self.fetched])
        self.assertEqual(open(os.path.join(self.tmp.name, "model2", "enc.onnx.data"), "rb").read(), b"weights")

    def test_a_copy_is_made_where_the_filesystem_will_not_link(self):
        self.sibling()
        real = os.link
        os.link = lambda *a, **k: (_ for _ in ()).throw(OSError("cross-device"))
        try:
            sc._download_pinned(self.dest, self.reuse_download("../other/weights.data"))
        finally:
            os.link = real
        self.assertEqual(open(os.path.join(self.dest, "enc.onnx.data"), "rb").read(), b"weights")
        self.assertNotIn("x/enc.onnx.data", [name for _, name, _ in self.fetched])

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
