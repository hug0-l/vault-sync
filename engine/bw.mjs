import { execFile } from "child_process";
import { promisify } from "util";
const x = promisify(execFile);
const OPT = { maxBuffer: 64 * 1024 * 1024, timeout: 180000 };
const redact = (s) => (s || "").replace(/[A-Za-z0-9+/=]{40,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 280);

export async function bw(args, { input, env } = {}) {
  const opts = { ...OPT, env: { ...process.env, ...env } };
  if (input !== undefined) opts.input = input;
  try {
    const r = await x("bw", [...args, "--nointeraction"], opts);
    return (r.stdout || "").trim();
  } catch (e) {
    throw new Error(redact((e.stderr || "") + " | " + (e.message || "")));
  }
}

export function bwClient(peer) {
  let session = null;
  const creds = { BW_CLIENTID: peer.clientId, BW_CLIENTSECRET: peer.clientSecret };
  return {
    async open() {
      await bw(["config", "server", peer.server]);
      await bw(["login", "--apikey"], { env: creds });
      session = await bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { ...creds, BW_PASSWORD: peer.master } });
    },
    raw: (args, extra = {}) => bw(args, { ...extra, env: { BW_SESSION: session } }),
    list: async (what) => JSON.parse((await bw(["list", what], { env: { BW_SESSION: session } })) || "[]"),
    async close() { try { await bw(["logout"]); } catch {} session = null; },
  };
}
