#!/bin/sh
# Unraid: /etc is tmpfs; re-arm root crontab entry after boot (works with busybox & vixie crond)
crontab -l 2>/dev/null | grep -q vault-sync || ( crontab -l 2>/dev/null; echo '17 4 * * * sh /mnt/user/appdata/vault-sync/run.sh >> /mnt/user/appdata/vault-sync/backups/sync.log 2>&1' ) | crontab -
