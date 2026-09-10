#!/bin/sh
set -eu
APP=/mnt/user/appdata/vault-sync
KEY=/boot/config/plugins/vaultsync/key
T=/dev/shm/vault-sync.$$.env
cleanup(){ rm -f "$T"; }
trap cleanup EXIT INT TERM
umask 077
exec 8>/dev/shm/vault-sync.lock
flock -n 8 || { echo "another run in progress"; exit 0; }
[ -f "$KEY" ] || { echo "FATAL: $KEY missing (USB config)"; exit 1; }
cp "$APP/.env" "$T"
dec(){ printf '%s' "$1" | base64 -d | openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$KEY"; echo; }
SRC=$(sed -n 's/^SRC_MASTER_ENC=//p' "$T")
DST=$(sed -n 's/^DST_MASTER_ENC=//p' "$T")
FPW=$(sed -n 's/^FILEPW_ENC=//p' "$T")
{
  printf 'SRC_MASTER=%s\n' "$(dec "$SRC")"
  printf 'DST_MASTER=%s\n' "$(dec "$DST")"
  printf 'FILEPW=%s\n' "$(dec "$FPW")"
} >> "$T"
docker run --rm --env-file "$T" -v "$APP/backups":/backup vault-sync:latest
