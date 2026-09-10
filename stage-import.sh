#!/bin/sh
set -eu
bw config server "$BW_SERVER" >/dev/null
if [ -n "$BW_CLIENTID" ]; then
  bw login --apikey --nointeraction >/dev/null
else
  bw login "$BW_EMAIL" "$BW_PASS" --nointeraction >/dev/null
fi
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --nointeraction --raw); export BW_SESSION
node /sync.mjs
bw logout >/dev/null
