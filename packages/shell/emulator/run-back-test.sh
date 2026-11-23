#!/usr/bin/env bash
# BACK-button run on the Docker emulator. Pins three behaviours of the main activity:
#   1. BACK at the app root moves the task to the background and does NOT end the
#      process (finishing the activity used to abort it); reopening resumes the same
#      page with no reload.
#   2. BACK on a page with in-app history steps back inside the app.
#   3. With voice mode running, BACK leaves the voice foreground service and the
#      gateway socket alive.
# Exits non-zero on the first failed check. Evidence lands in $EVIDENCE_DIR.
#
#   EVIDENCE_DIR=/path APK=/path/app-universal-debug.apk ./run-back-test.sh
#
# The emulator container must already be running (see packages/shell/README.md) and
# `npm install` must have been run in this directory. Set SKIP_VOICE=1 to run only
# the first two checks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
NAME=${EMULATOR_CONTAINER:-hf-emu}
OUT=${EVIDENCE_DIR:?set EVIDENCE_DIR}
APK=${APK:?set APK to the debug APK}
PORT=${FAKE_PORT:-7790}
APP=run.hundredfold.shell
mkdir -p "$OUT"
LOG="$OUT/back-test.log"
: > "$LOG"

adb() { docker exec "$NAME" adb "$@"; }
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
drive() { ADB="docker exec $NAME adb" node "$here/drive-shell.mjs" "$1"; }
pid() { adb shell pidof "$APP" | tr -d '\r' | awk '{print $1}' || true; }
fail() { say "FAIL: $*"; exit 1; }
top_activity() { adb shell dumpsys activity activities | grep topResumedActivity | head -1 | tr -d '\r' || true; }
in_foreground() { [[ "$(top_activity)" == *"$APP"* ]]; }
wait_page() { for _ in $(seq 1 40); do drive 'document.readyState' >/dev/null 2>&1 && return 0; sleep 1; done; fail "the page never loaded"; }
launch() { adb shell am start -n "$APP/.MainActivity" >/dev/null; }
no_abort() { ! adb logcat -d | grep -q -E 'FORTIFY|Fatal signal'; }
cleanup() { [ -z "${SERVER_PID:-}" ] || kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

say "== installing the app"
docker cp "$APK" "$NAME:/tmp/app.apk"
adb install -r -g /tmp/app.apk >/dev/null
adb shell am force-stop "$APP"
adb shell input keyevent 224 # wake
adb logcat -c

say "== 1. BACK at the root: the process must survive and resume the same page"
launch; wait_page
drive 'window.__marker = "same-page"; true' >/dev/null
P0=$(pid)
say "pid before BACK: $P0"
adb shell input keyevent 4
sleep 6
P1=$(pid)
say "pid after BACK:  ${P1:-<none>}"
[ -n "$P1" ] && [ "$P1" = "$P0" ] || fail "BACK at the root ended the process"
no_abort || fail "logcat shows an abort after BACK"
in_foreground && fail "the app is still in the foreground after BACK"
say "task moved to the background: yes"
launch; sleep 2
[ "$(pid)" = "$P0" ] || fail "reopening started a new process"
say "marker after reopening: $(drive 'window.__marker')"
[ "$(drive 'window.__marker')" = '"same-page"' ] || fail "reopening reloaded the page"

say "== 2. BACK with in-app history: steps back inside the app"
drive 'history.pushState({step:1},"","/#/step-one"); history.pushState({step:2},"","/#/step-two"); true' >/dev/null
say "location before BACK: $(drive 'location.hash')"
adb shell input keyevent 4; sleep 1
say "location after BACK 1: $(drive 'location.hash')"
[ "$(drive 'location.hash')" = '"#/step-one"' ] || fail "BACK did not step back inside the page"
in_foreground || fail "the app left the foreground while the page still had history"
adb shell input keyevent 4; sleep 1
say "location after BACK 2: $(drive 'location.hash')"
[ "$(drive 'location.hash')" = '""' ] || fail "second BACK did not return to the root route"
in_foreground || fail "the app left the foreground before the root"
adb shell input keyevent 4; sleep 3
[ "$(pid)" = "$P0" ] || fail "BACK at the root after in-app back ended the process"
no_abort || fail "logcat shows an abort"
say "root BACK after in-app BACKs: pid still $(pid), app in background"

[ "${SKIP_VOICE:-}" != 1 ] || { say "PASS (voice step skipped)"; exit 0; }

say "== 3. BACK while voice mode runs: the foreground service and the socket stay up"
SERVER_LOG="$OUT/server.jsonl"; : > "$SERVER_LOG"
node "$here/fake-voice-server.mjs" --port "$PORT" --log "$SERVER_LOG" >"$OUT/server.err" 2>&1 &
SERVER_PID=$!
sleep 1; kill -0 "$SERVER_PID" 2>/dev/null || { cat "$OUT/server.err"; exit 1; }
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
launch; sleep 2
drive "(async()=>{const n=window.__HUNDREDFOLD_NATIVE__;const t={origin:'http://127.0.0.1:$PORT'};await n.pair({target:t,code:'123456'});window.__ev=[];await n.voiceStart({target:t,sessionId:'demo-session',mode:'hands-free'},(m)=>window.__ev.push(m));await new Promise(r=>setTimeout(r,1500));return n.voiceStatus()})()" | tee -a "$LOG"
frames() { curl -s "localhost:$PORT/stats" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upFrames"])'; }
svc() { adb shell dumpsys activity services "$APP" | grep -c 'VoiceService' || true; }
PV0=$(pid); F0=$(frames)
say "voice service records before BACK: $(svc), pid $PV0"
[ "$(svc)" -gt 0 ] || fail "voice service not running before BACK"
adb shell input keyevent 4; sleep 3
F1=$(frames)
say "after BACK: pid $(pid), voice service records $(svc), +$((F1 - F0)) up frames in 3s, socket closes: $(grep -c socket_close "$SERVER_LOG" || true)"
[ "$(pid)" = "$PV0" ] && [ "$(svc)" -gt 0 ] && [ "$((F1 - F0))" -gt 100 ] && [ "$(grep -c socket_close "$SERVER_LOG" || true)" -eq 0 ] \
  || fail "BACK ended the voice session"
adb shell am force-stop "$APP"
say "PASS"
