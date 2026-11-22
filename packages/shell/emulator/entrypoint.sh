#!/bin/bash
# Starts the headless emulator. Its microphone and speaker are reached through
# the emulator's gRPC audio service (see emulator-audio.mjs); the container
# needs no sound server. The gRPC port is token-protected and the token is
# advertised in $XDG_RUNTIME_DIR/avd/running/pid_<pid>.ini.
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/emulator-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

exec emulator -avd voice \
  -no-window -no-snapshot -no-boot-anim -no-metrics \
  -gpu swiftshader_indirect -accel on \
  -memory 3072 -cores 4 \
  -netdelay none -netspeed full
