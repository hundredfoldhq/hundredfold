# Headless Android emulator with a virtual microphone and speaker, for running
# the Hundredfold shell's native voice client on a host without a display.
#
#   docker build -t hundredfold-android-emulator packages/shell/emulator
#
# The phone's microphone and speaker are driven through the emulator's gRPC audio
# service (emulator-audio.mjs on the host). The emulator's own PulseAudio backend
# does not initialise inside a container, so the image has no sound server.
#
#   docker run -d --name hf-emu --network host --device /dev/kvm \
#     --group-add "$(getent group kvm | cut -d: -f3)" hundredfold-android-emulator
FROM ubuntu:24.04

ARG CMDLINE_TOOLS=commandlinetools-linux-11076708_latest.zip
ARG ANDROID_API=34

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless unzip curl ca-certificates procps iproute2 \
      ffmpeg \
      libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
      libasound2t64 libgl1 libx11-6 libxkbfile1 libxrandr2 libxrender1 libdbus-1-3 \
    && apt-get clean

RUN useradd -m -u 1001 emu && mkdir -p /opt/android-sdk && chown emu /opt/android-sdk
USER emu
WORKDIR /home/emu

RUN curl -fsSL -o /tmp/cmdline.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS}" \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && unzip -q /tmp/cmdline.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/cmdline.zip \
    && (yes | sdkmanager --licenses >/dev/null) \
    && sdkmanager --install "platform-tools" "emulator" "system-images;android-${ANDROID_API};default;x86_64" >/dev/null \
    && echo no | avdmanager create avd -n voice -k "system-images;android-${ANDROID_API};default;x86_64" -d pixel_6 --force

COPY --chown=emu entrypoint.sh /home/emu/entrypoint.sh
RUN chmod +x /home/emu/entrypoint.sh
ENTRYPOINT ["/home/emu/entrypoint.sh"]
