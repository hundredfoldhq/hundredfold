#!/usr/bin/env bash
# Locked-screen voice run on the Docker emulator (specs/009-voice-mode/quickstart.md §8).
#
# Starts voice mode in the installed shell app, locks the phone behind a PIN,
# waits, then holds a spoken exchange with a barge-in while the phone is locked,
# and finally taps Stop on the lock-screen notification. A fake gateway that
# speaks the voice contract stands in for the voice hub. Evidence lands in
# $EVIDENCE_DIR: a screen recording with the audio, the lock-screen screenshots,
# the fake gateway's event log and a timeline.
#
#   EVIDENCE_DIR=/path APK=/path/app-universal-debug.apk \
#   QUESTION_WAV=question.wav INTERRUPT_WAV=interrupt.wav REPLY_WAV=reply.wav \
#   ./run-locked-screen-test.sh
#
# The WAVs are mono PCM16 speech. REPLY_WAV is what the fake gateway "says"
# (default: synthetic tones). The emulator container must already be running
# (see packages/shell/README.md) and `npm install` must have been run in this
# directory.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
NAME=${EMULATOR_CONTAINER:-hf-emu}
OUT=${EVIDENCE_DIR:?set EVIDENCE_DIR}
APK=${APK:?set APK to the debug APK}
QUESTION=${QUESTION_WAV:?set QUESTION_WAV}
INTERRUPT=${INTERRUPT_WAV:?set INTERRUPT_WAV}
REPLY=${REPLY_WAV:-}
LOCK_SECONDS=${LOCK_SECONDS:-60}
PORT=${FAKE_PORT:-7790}
PIN=1234
mkdir -p "$OUT"
SERVER_LOG="$OUT/server.jsonl"
TIMELINE="$OUT/timeline.log"
: > "$TIMELINE"

adb() { docker exec "$NAME" adb "$@"; }
now_ms() { date +%s%3N; }
T0=$(now_ms)
say() { printf '%7.1fs  %s\n' "$(echo "($(now_ms) - $T0) / 1000" | bc -l)" "$*" | tee -a "$TIMELINE"; }
count() { { grep -c "\"event\":\"$1\"" "$SERVER_LOG" || true; } | head -1; }
# wait_count <event> <at least> <timeout s>
wait_count() {
  local deadline=$(( $(date +%s) + $3 ))
  while [ "$(count "$1")" -lt "$2" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { say "TIMEOUT waiting for $1 >= $2"; return 1; }
    sleep 0.3
  done
}
drive() { ADB="docker exec $NAME adb" node "$here/drive-shell.mjs" "$1"; }
# Taps the centre of the first UI node whose text or content description matches
# (case-insensitive).
tap_text() {
  local text=$1 point
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  point=$(adb shell cat /sdcard/ui.xml | python3 -c '
import re, sys
want = sys.argv[1].lower()
for m in re.finditer(r"<node[^>]*>", sys.stdin.read()):
    node = m.group(0)
    text = re.search(r"text=\"([^\"]*)\"", node).group(1).lower()
    desc = re.search(r"content-desc=\"([^\"]*)\"", node).group(1).lower()
    if want in (text, desc):
        a, b, c, d = map(int, re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", node).groups())
        print((a + c) // 2, (b + d) // 2)
        break
' "$text")
  [ -n "$point" ] || return 1
  # shellcheck disable=SC2086
  adb shell input tap $point
}

cleanup() {
  [ -z "${SERVER_PID:-}" ] || kill "$SERVER_PID" 2>/dev/null || true
  [ -z "${SPEAKER_PID:-}" ] || kill "$SPEAKER_PID" 2>/dev/null || true
  adb shell locksettings clear --old "$PIN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export EMULATOR_GRPC_TOKEN
EMULATOR_GRPC_TOKEN=$(docker exec "$NAME" bash -c 'grep -h grpc.token /tmp/emulator-runtime/avd/running/pid_*.ini' | head -1 | cut -d= -f2-)

say "installing the app"
docker cp "$APK" "$NAME:/tmp/app.apk"
adb install -r -g /tmp/app.apk >/dev/null
adb shell am force-stop run.hundredfold.shell
adb shell settings put system screen_off_timeout 600000
adb shell input keyevent 224 # wake

say "starting the fake gateway on :$PORT (stands in for the voice hub)"
: > "$SERVER_LOG"
node "$here/fake-voice-server.mjs" --port "$PORT" --log "$SERVER_LOG" ${REPLY:+--reply "$REPLY"} >"$OUT/server.err" 2>&1 &
SERVER_PID=$!
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || { cat "$OUT/server.err"; exit 1; }
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null

say "launching the app, pairing, starting voice mode (hands-free)"
adb shell am start -n run.hundredfold.shell/.MainActivity >/dev/null
for _ in $(seq 1 30); do drive 'document.readyState' >/dev/null 2>&1 && break; sleep 1; done
drive "(async()=>{const n=window.__HUNDREDFOLD_NATIVE__;const t={origin:'http://127.0.0.1:$PORT'};await n.pair({target:t,code:'123456'});window.__ev=[];await n.voiceStart({target:t,sessionId:'demo-session',mode:'hands-free'},(m)=>window.__ev.push(m));await new Promise(r=>setTimeout(r,1500));return n.voiceStatus()})()" | tee -a "$TIMELINE"
wait_count hello 1 10
say "voice mode is up: hello received from a '$(grep -o '"client":"[a-z]*"' "$SERVER_LOG" | head -1)' client"

say "setting a PIN, starting the screen recording and the speaker capture"
adb shell locksettings set-pin "$PIN" >/dev/null
SR_START=$(now_ms)
docker exec -d "$NAME" adb shell screenrecord --time-limit 180 --bit-rate 3000000 /sdcard/run.mp4
node "$here/emulator-audio.mjs" record "$OUT/phone-speaker.wav" --seconds 175 >/dev/null 2>&1 &
SPEAKER_PID=$!
sleep 2

say "locking the phone (power key); the screen goes off behind the PIN"
adb shell input keyevent 26
sleep 3
adb shell "dumpsys power | grep -m1 mWakefulness=" 2>/dev/null | tee -a "$TIMELINE"
adb shell "dumpsys window | grep -m1 isKeyguardShowing" 2>/dev/null | tee -a "$TIMELINE"
FRAMES_LOCKED=$(curl -s "localhost:$PORT/stats" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upFrames"])')
say "locked. up-audio frames received so far: $FRAMES_LOCKED. Waiting ${LOCK_SECONDS}s with the screen off"
sleep "$LOCK_SECONDS"
FRAMES_AFTER=$(curl -s "localhost:$PORT/stats" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upFrames"])')
say "after ${LOCK_SECONDS}s locked: $FRAMES_AFTER frames (+$((FRAMES_AFTER - FRAMES_LOCKED)); 50 per second expected)"

say "waking the display; the phone stays locked (keyguard + notification)"
adb shell input keyevent 224
sleep 2
adb shell "dumpsys window | grep -m1 isKeyguardShowing" 2>/dev/null | tee -a "$TIMELINE"
adb exec-out screencap -p > "$OUT/lock-screen.png"

say "user speaks while locked (question)"
Q_AT=$(now_ms)
node "$here/emulator-audio.mjs" inject "$QUESTION" >>"$TIMELINE"
wait_count utterance 1 30
say "gateway heard the utterance"
wait_count segment_start 1 30
say "reply is playing; letting it run 2.5s, then interrupting while locked"
sleep 2.5
B_AT=$(now_ms)
node "$here/emulator-audio.mjs" inject "$INTERRUPT" >>"$TIMELINE" &
INJ_PID=$!
wait_count barge_in 1 10
say "barge-in reached the gateway: $(grep '"event":"barge_in"' "$SERVER_LOG" | head -1)"
wait "$INJ_PID"
wait_count utterance 2 30
say "second utterance heard; waiting for the second reply to finish"
wait_count reply_complete 1 60
say "reply complete (played reported for every segment)"
adb exec-out screencap -p > "$OUT/lock-screen-after.png"

say "Stop from the notification, still locked: expanding it and tapping STOP"
adb shell input keyevent 224
sleep 1.5
tap_text "Expand"
sleep 1.5
adb exec-out screencap -p > "$OUT/lock-screen-stop.png"
tap_text "STOP"
sleep 3
wait_count bye 1 10
say "gateway saw bye and the close: $(grep -E '"event":"(bye|socket_close)"' "$SERVER_LOG" | tr '\n' ' ')"
say "voice service running after Stop: $(adb shell dumpsys activity services run.hundredfold.shell | grep -c 'VoiceService')"
say "web events: $(drive 'JSON.stringify(window.__ev.filter(e=>e.type==="native_state"))')"

say "collecting the recordings"
adb shell pkill -INT screenrecord >/dev/null 2>&1 || true
sleep 3
kill -TERM "$SPEAKER_PID" 2>/dev/null || true
SPEAKER_PID=
sleep 2
adb pull /sdcard/run.mp4 /tmp/run.mp4 >/dev/null
docker cp "$NAME:/tmp/run.mp4" "$OUT/screen.mp4"
adb logcat -d -s HundredfoldVoice:V AndroidRuntime:E > "$OUT/logcat-voice.txt" || true

say "muxing screen + phone speaker + the user's speech into one video"
# Everything is placed on the screen recording's clock: the speaker capture
# carries the wall-clock time of its first packet, the injected speech was
# started at known times.
SPK_START=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["startEpochMs"])' "$OUT/phone-speaker.wav.json")
SPK_DELAY=$(( SPK_START - SR_START ))
Q_DELAY=$(( Q_AT - SR_START ))
B_DELAY=$(( B_AT - SR_START ))
[ "$SPK_DELAY" -ge 0 ] || SPK_DELAY=0
docker cp "$OUT/screen.mp4" "$NAME:/tmp/screen.mp4"
docker cp "$OUT/phone-speaker.wav" "$NAME:/tmp/phone-speaker.wav"
docker cp "$QUESTION" "$NAME:/tmp/question.wav"
docker cp "$INTERRUPT" "$NAME:/tmp/interrupt.wav"
docker exec "$NAME" ffmpeg -y -loglevel error \
  -i /tmp/screen.mp4 -i /tmp/phone-speaker.wav -i /tmp/question.wav -i /tmp/interrupt.wav \
  -filter_complex "[1:a]aresample=48000,adelay=${SPK_DELAY}|${SPK_DELAY}[spk];[2:a]aresample=48000,adelay=${Q_DELAY}|${Q_DELAY},volume=0.7[q];[3:a]aresample=48000,adelay=${B_DELAY}|${B_DELAY},volume=0.7[b];[spk][q][b]amix=inputs=3:normalize=0:duration=longest,apad[a]" \
  -map 0:v -map "[a]" -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 96k -shortest /tmp/locked-screen-voice.mp4
docker cp "$NAME:/tmp/locked-screen-voice.mp4" "$OUT/locked-screen-voice.mp4"
say "done: $OUT/locked-screen-voice.mp4"
