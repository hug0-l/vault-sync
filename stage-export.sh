#!/bin/sh
set -eu
bw config server "$BW_SERVER" >/dev/null
bw login --apikey --nointeraction >/dev/null
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --nointeraction --raw); export BW_SESSION
bw export --format encrypted_json --password "$FILEPW" --output "$SRC_OUT" --nointeraction
bw export --format json --output "$SRC_PLAIN" --nointeraction
chmod 600 "$SRC_PLAIN"
bw logout >/dev/null
