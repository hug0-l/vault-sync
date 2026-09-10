#!/bin/sh
set -eu
cd /backup
log(){ echo "[$(date '+%F %T')] $*"; }

: "${SRC_SERVER:?SRC_SERVER missing}"
: "${SRC_CLIENT_ID:?SRC_CLIENT_ID missing}"
: "${SRC_CLIENT_SECRET:?SRC_CLIENT_SECRET missing}"
: "${SRC_MASTER:?SRC_MASTER missing}"
: "${DST_SERVER:=https://vault.bitwarden.com}"
: "${DST_MASTER:?DST_MASTER missing}"
: "${FILEPW:?FILEPW missing}"

OUT="/backup/vaultwarden-$(date +%F).json"
PLAIN="/dev/shm/vault-sync-$$.json"
MAP=/backup/mapping.json

log "1/2 export vaultwarden ($SRC_SERVER)"
BW_SERVER="$SRC_SERVER" BW_CLIENTID="$SRC_CLIENT_ID" BW_CLIENTSECRET="$SRC_CLIENT_SECRET" \
BW_PASSWORD="$SRC_MASTER" SRC_OUT="$OUT" SRC_PLAIN="$PLAIN" sh /stage-export.sh

log "2/2 incremental sync -> target ($DST_SERVER)"
BW_SERVER="$DST_SERVER" BW_CLIENTID="${DST_CLIENT_ID:-}" BW_CLIENTSECRET="${DST_CLIENT_SECRET:-}" \
BW_EMAIL="${DST_EMAIL:-}" BW_PASS="${DST_PASSWORD:-}" \
BW_PASSWORD="$DST_MASTER" PLAIN_FILE="$PLAIN" MAP_FILE="$MAP" sh /stage-import.sh
rm -f "$PLAIN"

log "done: $(basename "$OUT") ($(wc -c < "$OUT") bytes), keeping 7 newest"
ls -t vaultwarden-*.json | tail -n +8 | xargs -r rm -f
