# vault-sync

Headless, one-way **incremental** backup from a self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) server to a second Bitwarden-compatible server (e.g. the official Bitwarden cloud) — designed to run unattended from cron with **no plaintext secrets at rest**.

Unlike a full `bw export` → `bw import` (which dumps and re-imports every item nightly), vault-sync keeps a local mapping of source↔target item ids and applies only the real diff: creates new items, edits changed ones, deletes removed ones. Typical nightly run on a ~1000-item vault: **under a minute**.

## Architecture

```
cron ──► run.sh                # decrypts *_ENC secrets (openssl, key on local disk) → tmpfs env, flock guard
           └─► docker run (this image)
                 ├─ stage-export.sh   # source: bw apikey login → encrypted archive to /backup
                 │                     #           + plaintext export to container RAM (/dev/shm) only
                 └─ sync.mjs          # target: bw list (1 API call) → semantic diff via
                                      #   mapping.json → create/edit/delete only what changed
                                      #   (name-adoption self-heals mapping drift)
```

- **Encrypted archive**: `vaultwarden-YYYY-MM-DD.json` (Bitwarden `encrypted_json`, sealed with a separate file password) kept in `backups/` — N-day rotation, restorable anywhere:
  `bw import bitwardenjson FILE --passwordenv FILEPW`
- **Mapping**: `backups/mapping.json` (source id ↔ target id). If it drifts, unique-name adoption repairs it; delete it to force full re-adoption.

## Requirements

- Docker host (Unraid-friendly; plain POSIX `sh`, no bashisms)
- `@bitwarden/cli` ≥ 2026.8 (installed in the image via `npm`)
- **API keys on both accounts** (Vaultwarden and the target server → Account → Security → API Key). API-key auth skips interactive 2FA/device-verification, which is what makes this headless-safe.
- The target vault should be a **dedicated backup account** — it is kept as a mirror; anything you add there will be deleted on the next sync.

## Setup

```bash
cd /path/to/vault-sync
docker build -t vault-sync:latest .
cp env.example .env && chmod 600 .env        # fill API keys (secrets), keep *_ENC lines
# encrypt the master passwords + file password with a key that lives OUTSIDE the app dir,
# e.g. on the Unraid USB (survives reboot, never in array backups):
head -c 32 /dev/urandom | base64 > /boot/config/plugins/vaultsync/key
enc(){ printf '%s' "$1" | openssl enc -aes-256-cbc -pbkdf2 -pass file:/boot/config/plugins/vaultsync/key | base64 -w0; }
#   → paste output into *_ENC entries; generate FILEPW with head -c 18 /dev/urandom | base64
./install.sh                                  # arms the nightly crontab entry (root)
sh run.sh                                     # first (seed) run — creates all target items
```

## Config (`.env`)

| Key | Meaning |
| --- | --- |
| `SRC_SERVER` / `SRC_CLIENT_ID` / `SRC_CLIENT_SECRET` | source Vaultwarden + API key |
| `SRC_MASTER_ENC` | openssl-encrypted source master password (unlocked for export) |
| `DST_SERVER` / `DST_CLIENT_ID` / `DST_CLIENT_SECRET` | target server + API key |
| `DST_MASTER_ENC` | encrypted target master password |
| `FILEPW_ENC` | encrypted file password sealing the archive (≠ master) |

`run.sh` decrypts these into `/dev/shm` per run and never writes plaintext to disk. (Unraid users: **do not** name the key file `*.key` directly under `/boot/config/` — emhttpd treats it as a disk encryption key and spams the log. Use a subdirectory.)

## Debugging

- `DRY_RUN=1` — compute and print the plan, apply nothing
- `DEBUG_DIFF=1` — print the first few field-level differences feeding the plan
- Logs land in `backups/sync.log` (see cron line)

## Known CLI gotchas encoded here

- `bw create/edit item` takes the **base64-encoded JSON as a positional argument** (and `encode`-via-subprocess is not needed — it's just base64)
- `bw export` uses `--password` (value), `bw import` uses `--passwordenv` (var name), `--format` is singular, `list` prints JSON natively (no `--output/--json`)
- `bw config server <url>` is required — `BW_SERVER` env is ignored by recent builds
- Recent cloud `list items` responses add per-item `key`/`object` fields absent from exports — normalized away or every item diffs nightly
- Never run two syncs concurrently: sessions stale each other → `item out of date` storms (`run.sh` flocks for you)
- Free Bitwarden cloud tiers gate file attachments and file-Sends behind Premium — the CRUD-mirror approach exists for exactly that reason

## License

MIT
