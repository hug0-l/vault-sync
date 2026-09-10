# vault-sync

A self-contained container that keeps a second Bitwarden-compatible vault as an **encrypted, incremental mirror** of your primary [Vaultwarden](https://github.com/dani-garcia/vaultwarden) (or any two Bitwarden-API servers, either direction) — with a small web UI for credentials, scheduling, logs and manual runs.

Built for unattended nightly operation on NAS boxes (developed on Unraid), headless-safe: API-key auth skips interactive 2FA/device challenges, and everything sensitive is encrypted at rest.

## Features

- **Incremental mirror** — computes a semantic diff (source snapshot vs target state + stored id mapping) and applies only creates/edits/deletes. Typical nightly run of a ~1000-item vault: **seconds**, not minutes
- **Archive mode** — daily Bitwarden `encrypted_json` export (sealed with a dedicated file password, separate from your master) with day-based retention, restorable anywhere: `bw import bitwardenjson FILE --passwordenv FILEPW`
- **Web UI** — status, logs, run-now, schedule (daily / every-N-hours / manual), direction & method switch, masked credential editor with per-peer live connection test, TOTP 2FA for the UI itself
- **Encrypted config** — all credentials live in `config.enc` (AES-256-GCM, scrypt-derived); the key file is meant to live on non-array media (e.g. Unraid USB at `/boot/config/...`) mounted read-only into the container
- **Self-healing mapping** — target items are matched by stored ids first, then by unique-name adoption (with count-aware pairing for duplicate names); flipping direction automatically **inverts** the existing mapping instead of re-adopting

## Quick start

```bash
docker build -t vault-sync .
docker run -d --name vault-sync --restart unless-stopped \
  -p 127.0.0.1:8770:8770 \
  -v /srv/vault-sync:/data \
  -v /path/to/keyfile:/run/secrets/key:ro \
  vault-sync
```

Open the UI, complete the setup wizard (admin password + two peers), press **Test** on each peer, then **Run now**. The internal scheduler handles the rest. No crontab required.

Each peer needs: server URL, **API key** (client_id/client_secret — vaultwarden: account → security → API Key; bitwarden.com: account → API Key, may require enabling 2FA first), and the master password.

> ⚠️ The UI serves plain HTTP and stores the keys to your password vaults. Bind the port to a trusted interface (as above), **do not** put it behind a public reverse proxy, and enable the built-in TOTP 2FA.

## Security model

| Secret | At rest | In memory |
|---|---|---|
| API client secrets, master passwords, file password | AES-256-GCM `config.enc` (key = mounted file, outside `/data`) | process env for the seconds of use |
| Nightly archive | Bitwarden encrypted_json, sealed with a **separate file password** (not stored anywhere else) | — |
| Plaintext vault data | never written to disk | container tmpfs (`/dev/shm`) during a run only |

- No credentials are ever returned by the API (masked `····xxxx`); they're only replaced, never read.
- `bw` child-process errors are redacted (base64 payloads stripped) before hitting the log.
- Login rate limiting (5/min per IP) + optional TOTP.
- If no key file is mounted, a random one is generated inside `/data` with a loud UI warning — the encryption then only protects against casual disk reads.

## How the mirror diff works

`mapping.json` (inside `/data/backups/`) stores `{direction: {source_id → target_id}}`. Each run:

1. source snapshot via `bw export --format json` (tmpfs only) + encrypted archive written
2. target state via one `bw sync` + `bw list items/folders`
3. diff under normalization: volatile fields (`id`, `key`, `object`, `revisionDate`, `reprompt`, empty optionals, …) are stripped from **both** sides, so a steady-state vault produces a zero-op plan
4. `create / edit / delete` applied at concurrency 2 with backoff; mapping checkpointed every 25 ops

**Direction semantics** — this is a one-way mirror: `B>A` makes the source side's content overwrite the target. It is *not* two-way merge (that's on the roadmap; the data model already stores both peers symmetrically). Target items unknown to the mapping are **left alone** (never deleted) as a safety policy.

## Files

```
server.mjs         API + scheduler
auth.mjs           bcrypt login, TOTP (otplib), rate limit, sessions
crypto.mjs         config.enc envelope (scrypt + AES-256-GCM)
engine/bw.mjs      hardened @bitwarden/cli wrapper (positional base64 args, redacted errors)
engine/plan.mjs    pure diff/normalization/adoption
engine/apply.mjs   concurrent job runner with checkpointing
engine/run.mjs     cycle orchestration, mapping buckets + direction inversion, retention
public/index.html  single-page UI (no framework)
Dockerfile         node:20-alpine + @bitwarden/cli@latest
```

## Debugging

- `DRY_RUN=1` — every run computes and logs the plan, applies nothing
- `DEBUG_DIFF=1` — reserved for field-level diff tracing
- logs: `/data/sync.log` (also in the UI), state: `/data/state.json`

## License

MIT
