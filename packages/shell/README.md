# @hundredfold/shell

The Tauri 2 shell for Hundredfold desktop and mobile targets. It bundles the production
web dashboard; it never navigates the main webview to a gateway URL.

## Security boundary

On Apple platforms, gateway credentials live in Keychain, scoped to the exact
canonical origin including its port. The keyring build enables the Apple backend
only, so Android has no OS-backed store at all and must never be represented as
secure storage support. The bundled dashboard can call four gateway commands
only: `pair`, `request`, `stream`, and `forget`. Those commands accept
root-relative gateway paths, reject credential-bearing headers and redirects,
and return no cookie or token to JavaScript.

Plain HTTP gateways are accepted only on loopback — a literal loopback address
or the name `localhost`. LAN, tailnet, and remote gateways require HTTPS. Each
of those four commands also verifies that it came from the local `main` window,
so any remote document fails closed; the desktop-only `report` command confines
itself to the probe window the same way. Tauri capabilities contain no `remote`
grants.

The strict CSP permits no remote origin: script and connect sources are the
bundled assets and Tauri IPC, alongside `data:`/`blob:` media and inline styles.
Gateway REST and WebSocket traffic runs in Rust, so gateway origins do not appear
in `connect-src`. External HTTP(S) links open in the system browser.

## Build

Prerequisites are pnpm, Rust, and Tauri CLI 2. Every command below stages the
production web output first, so run `pnpm --filter @hundredfold/web build` once before
`test` in a fresh clone.

```sh
pnpm --filter @hundredfold/shell test
pnpm --filter @hundredfold/shell desktop:build
pnpm --filter @hundredfold/shell ios:init
pnpm --filter @hundredfold/shell android:init
```

`desktop:build` first builds `@hundredfold/web`, atomically stages that output with the
refresh probe, then creates the native bundle. The macOS unsigned app is written
under `src-tauri/target/release/bundle/macos/`.

Signing, notarization, store distribution, and device deployment are release
concerns and are not implied by a successful local unsigned build.

The generated Apple and Android projects are committed under `src-tauri/gen/`.
Initialization does not prove device execution: Apple device builds still need
a development team, while Android requires a supported JDK/SDK/NDK toolchain
and a real credential-store backend before release.

## Native voice mode (locked-screen voice)

Voice mode has to keep working with the screen locked, and a web page cannot keep
the microphone once the phone locks, so in the mobile app the whole voice loop is
native. While voice runs, capture, playback and the gateway socket never pass
through JavaScript (a backgrounded WebView may suspend it):

```
Kotlin / Swift audio  <->  Rust (src/voice.rs)  <->  gateway /ws/voice/:sessionId
  capture (platform AEC),     hundredfold-voice-core      (the same `stream`
  flushable playback,         state machine               socket machinery, same
  onset detector,                                          pairing credential)
  lock-screen Stop
```

The web UI only starts and stops the session and receives the gateway's JSON frames.
Everything below is specified in `specs/009-voice-mode/contracts/native-voice.md`.

| Command | Input | Result |
|---|---|---|
| `voice_start` | `{ target, sessionId, mode: "hands-free" \| "push-to-talk" }` and an event channel | `{ ok }`, or an error code: `permission-denied`, `not-paired`, `unsupported`, `voice-busy`, `invalid-path`, `invalid-request`, `transport-failed` |
| `voice_stop` | none | `{ ok }` |
| `voice_ptt` | `{ down }` | `{ ok }` |
| `voice_status` | none | `{ running, state }` (`idle`, `connecting`, `running`, `paused`, `stopped`) |

They are confined to the local `main` window like the other four, and the bundle
exposes them to the web app as `window.__HUNDREDFOLD_NATIVE__.{voiceStart, voiceStop,
voicePtt, voiceStatus}` on the mobile shells only (the desktop shell leaves them
out, so the web app keeps using the browser's audio there); `voiceStart(input, onFrame)`
passes the channel's messages to `onFrame`. Error codes are kebab-case, like the
shell's other native errors.

The channel carries the gateway's frames unchanged (`ready`, `transcript`,
`segment_start`, `turn`, `detached`, ...; binary audio is never forwarded) plus the
shell-only `native_state` object, which reports the native session's own state (so
the web UI learns of a Stop from the notification or a pause for a call). Its shape
and `reason` values are specified in `specs/009-voice-mode/contracts/native-voice.md`.
A web UI that is suspended or gone does not end the session. On Android, BACK at the
app root moves the task to the background while voice runs instead of finishing the
activity, and removing the task from recents ends the session cleanly (`bye`, close
1000). A page reload cannot reattach to a running session yet.

### Platform status

| | Android | iOS |
|---|---|---|
| Code | `gen/android/.../voice/` (Kotlin) and `src/android.rs` (JNI) | `gen/apple/Sources/hundredfold-shell/voice/` (Swift) and `src/ios.rs` |
| Session | foreground service, type `microphone`, ongoing notification with Stop, wake and Wi-Fi locks | `AVAudioSession` `.playAndRecord` / `.voiceChat`, `UIBackgroundModes: audio` |
| Capture | `AudioRecord` `VOICE_COMMUNICATION` + `AcousticEchoCanceler` | `AVAudioEngine` with voice processing |
| Playback | streaming `AudioTrack`, flushed on onset or `stop_playback` | `AVAudioPlayerNode`, flushed the same way |
| Lock-screen control | notification action "Stop" | Now Playing "Voice mode on" with a stop command |
| Status | built, and run on an emulator with the screen locked (below) | **written to the contract, never built or run**: it needs a Mac with Xcode and an Apple team |

Behaviour worth knowing: a call or assistant that takes the audio pauses voice mode
and it resumes when the system hands the audio back; another app taking the audio
for good (music, video) ends voice mode (`native_state` stopped, reason `interruption`)
rather than leaving a "listening" notification over a paused session; on iOS the same
happens when an interruption ends without `.shouldResume` or the audio cannot be
restarted. A gateway that does not answer `hello` with `ready` within 10 s ends it
with reason `error`. A route change that alters the input format (headphones, AirPods)
rebuilds the capture path and keeps going. In
push-to-talk the microphone stays open and only frames between `ptt_down` and
`ptt_up` are sent.

Android and the Rust core do not depend on the iOS files. The Xcode project
(`gen/apple/hundredfold-shell.xcodeproj`) references the voice sources, the bridging
header, `AVFoundation` and `MediaPlayer`; `gen/apple/project.yml` is its source, and
the committed `project.pbxproj` was edited by hand to match it, not generated or opened
in Xcode. On a Mac, regenerate it (`xcodegen generate` in `gen/apple`) and build before
relying on it. Unverified on iOS in particular: route changes and interruption
recovery on a device, that `setVoiceProcessingEnabled(true)` leaves an input format
`AVAudioConverter` can convert to 16 kHz mono (`start` returns false if not), and the
Now Playing stop command on a locked device. The emulator has no
acoustic echo canceller (`AcousticEchoCanceler.isAvailable()` is false there), so
echo cancellation is only exercised on a real phone.

Credentials: the keyring build enables the Apple backend only, so on Android there
is no OS-backed store. Off Apple platforms the shell therefore keeps the pairing
credential in a process-lifetime, in-memory store (compiled only for non-Apple
targets; the Apple build is unchanged). It is never written to disk, a pairing lasts
until the app process ends and the user then pairs again (while voice runs the
foreground service keeps the process alive), and it is **not** secure storage and
must not be described as such. Persistent Android Keystore storage is a separate
security change, not part of this feature.

### Rust tests

`pnpm --filter @hundredfold/shell test` runs the platform-independent core
(`src-tauri/voice-core`: frame bridge, state machine, barge-in and interruption
rules) wherever cargo is installed, and the shell crate's own tests on macOS. The
shell crate also builds and tests on Linux once the WebKitGTK development packages
are present, for example in a container (this also covers the confinement tests of
the voice commands, which run against a mock window):

```sh
docker run --rm -v "$PWD/packages/shell:/shell" -e CARGO_TARGET_DIR=/target -w /shell/src-tauri rust:1-bookworm bash -c '
  apt-get update -qq && apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    librsvg2-dev libssl-dev pkg-config libayatana-appindicator3-dev libxdo-dev &&
  cargo test --workspace'
```

The Kotlin onset detector, playback ledger and interrupt guard have JVM unit tests:

```sh
cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest
```

## Android toolchain (no root, nothing system-wide)

Everything lives under one directory you choose; `$TOOLCHAIN` below. Versions are
the ones this was built with.

```sh
export TOOLCHAIN=$HOME/hundredfold-toolchain
mkdir -p $TOOLCHAIN/{jdk,android-sdk,rustup,cargo,dl}

# JDK 17 (Temurin)
curl -fsSL -o $TOOLCHAIN/dl/jdk17.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
tar -xzf $TOOLCHAIN/dl/jdk17.tar.gz -C $TOOLCHAIN/jdk --strip-components=1

# Rust stable with the Android targets
curl -fsSL https://sh.rustup.rs -o $TOOLCHAIN/dl/rustup-init.sh
RUSTUP_HOME=$TOOLCHAIN/rustup CARGO_HOME=$TOOLCHAIN/cargo sh $TOOLCHAIN/dl/rustup-init.sh -y \
  --no-modify-path --profile minimal \
  -t aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android

# Android command-line tools, then the SDK and NDK
curl -fsSL -o $TOOLCHAIN/dl/cmdline.zip \
  https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
mkdir -p $TOOLCHAIN/android-sdk/cmdline-tools
unzip -q $TOOLCHAIN/dl/cmdline.zip -d $TOOLCHAIN/android-sdk/cmdline-tools
mv $TOOLCHAIN/android-sdk/cmdline-tools/cmdline-tools $TOOLCHAIN/android-sdk/cmdline-tools/latest
```

Then put this in a file you can `source` (every shell that builds needs it):

```sh
export RUSTUP_HOME=$TOOLCHAIN/rustup CARGO_HOME=$TOOLCHAIN/cargo JAVA_HOME=$TOOLCHAIN/jdk
export ANDROID_HOME=$TOOLCHAIN/android-sdk ANDROID_SDK_ROOT=$TOOLCHAIN/android-sdk
export NDK_HOME=$TOOLCHAIN/android-sdk/ndk/27.2.12479018
export PATH=$TOOLCHAIN/cargo/bin:$TOOLCHAIN/jdk/bin:$TOOLCHAIN/android-sdk/cmdline-tools/latest/bin:$TOOLCHAIN/android-sdk/platform-tools:$PATH
```

```sh
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.2.12479018"
cargo install tauri-cli --version "^2" --locked        # provides `cargo tauri`
```

Build a debug APK (the emulator below is x86_64; add `--target aarch64` for phones).
The web bundle must exist first:

```sh
pnpm --filter @hundredfold/gateway-events build
pnpm --filter @hundredfold/web build
pnpm --filter @hundredfold/shell prepare:frontend
cd packages/shell
cargo tauri android build --debug --apk --target x86_64 --config src-tauri/tauri.conf.json --ci
# -> src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The build also rewrites the deep-link block in `AndroidManifest.xml`; that edit is
generated and is not committed.

## Android emulator under Docker

`/dev/kvm` is usually not open to the build user, but membership of the `docker`
group is enough to give a container the device. `emulator/` holds the image and the
scripts.

```sh
docker build -t hundredfold-android-emulator packages/shell/emulator
docker run -d --name hf-emu --network host --device /dev/kvm \
  --group-add "$(getent group kvm | cut -d: -f3)" hundredfold-android-emulator
until [ "$(docker exec hf-emu adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 4; done
```

The image runs the emulator headless (Android 14, x86_64, no Google services). Its
own PulseAudio backend does not initialise in a container, so the phone's microphone
and speaker are driven through the emulator's gRPC audio service instead
(`emulator/emulator-audio.mjs`; `cd packages/shell/emulator && npm install` first).
`--network host` lets `adb reverse` reach services on the host; the gRPC port is
token-protected and only on loopback.

### Locked-screen run (spec quickstart §8)

`emulator/run-locked-screen-test.sh` installs the APK, starts voice mode, sets a PIN
and locks the phone, waits `LOCK_SECONDS` (default 60) with the screen off, wakes
the display (still locked), speaks a question into the phone's microphone, speaks
over the reply to barge in, lets the second reply finish, and taps **Stop** on the
lock-screen notification. It checks the gateway log at each step and writes a screen
recording with sound, screenshots and a timeline to `$EVIDENCE_DIR`.

```sh
EVIDENCE_DIR=./evidence APK=<path to the APK> \
QUESTION_WAV=question.wav INTERRUPT_WAV=interrupt.wav REPLY_WAV=reply.wav \
  packages/shell/emulator/run-locked-screen-test.sh
```

Until the gateway's voice hub is available, `emulator/fake-voice-server.mjs` stands
in for it. It speaks the socket contract (pairing, `hello`/`ready`, a level-based
VAD, a canned transcript, a spoken reply split into segments, `barge_in`, `played`,
`stop_playback`, `bye`) with no speech recognition: the transcript is a placeholder.
To run it against a real gateway instead, drop the fake and point
`drive-shell.mjs` at that origin.

## Retained desktop behavior

The native menu, icon, restored window geometry, `hundredfold://` deep links, and the
opt-in refresh-rate probe from the desktop spike remain. `hundredfold://org` and other
custom-scheme routes resolve inside bundled assets. Set `HUNDREDFOLD_SHELL_PROBE=1`
when launching the shell to open the local probe window.
