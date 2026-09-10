import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig, saveConfig, keyMaterial, newSecret } from "./crypto.mjs";
import { login as authLogin, hashPw, valid, revoke, rateLimited, newTotpSecret, totpUrl, totpCheck } from "./auth.mjs";
import { bwClient } from "./engine/bw.mjs";
import { runOnce } from "./engine/run.mjs";

const PORT = Number(process.env.PORT || 8770);
const DATA_DIR = process.env.DATA_DIR || "/data";
const dirs = { data: DATA_DIR, backups: path.join(DATA_DIR, "backups") };
fs.mkdirSync(dirs.backups, { recursive: true });
const LOGFILE = path.join(DATA_DIR, "sync.log");
const STATEFILE = path.join(DATA_DIR, "state.json");

let cfg = null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reload = () => { try { cfg = loadConfig(); } catch (e) { console.error("config load failed:", e.message); cfg = null; } };
reload();

const app = express();
app.use(express.json({ limit: "1mb" }));

let running = false;
const log = (msg) => fs.appendFileSync(LOGFILE, `[${new Date().toISOString()}] ${msg}\n`);
const sidFrom = (req) => (req.headers.cookie || "").match(/vsid=([^;]+)/)?.[1];

app.use("/api", (req, res, next) => {
  const p = req.path.replace(/^\//, "");
  if (p === "login" || p === "init") return next();
  if (!cfg) return res.status(503).json({ setup: true });
  if (!valid(sidFrom(req))) return res.status(401).json({ error: "unauthorized" });
  next();
});

const mask = (v) => (v ? "····" + String(v).slice(-4) : "");
const redacted = () => {
  const p = (x) => ({ server: x?.server || "", clientId: mask(x?.clientId), clientSecretSet: !!x?.clientSecret, masterSet: !!x?.master });
  return {
    direction: cfg.direction, method: cfg.method, schedule: cfg.schedule, retention: cfg.retention,
    a: p(cfg.peers.A), b: p(cfg.peers.B), totpEnabled: !!cfg.admin?.totp?.enabled,
  };
};

app.post("/api/init", (req, res) => {
  if (cfg) return res.status(400).json({ error: "already initialized" });
  const b = req.body || {};
  if (!b.adminPassword || b.adminPassword.length < 8) return res.status(400).json({ error: "admin password >= 8 chars required" });
  cfg = {
    version: 2,
    peers: { A: cleanPeer(b.a), B: cleanPeer(b.b) },
    direction: b.direction === "B>A" ? "B>A" : "A>B",
    method: b.method === "archive-only" ? "archive-only" : "mirror",
    schedule: normSchedule(b.schedule),
    retention: clampRetention(b.retention),
    filepw: newSecret(),
    admin: { passhash: hashPw(b.adminPassword) },
  };
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  if (!cfg) return res.status(404).json({ error: "not initialized" });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "too many attempts" });
  const sid = authLogin(cfg, req.body?.password || "", req.body?.code);
  if (!sid) return res.status(401).json({ error: "invalid credentials", totpExpected: !!cfg.admin?.totp?.enabled && !req.body?.code });
  res.setHeader("Set-Cookie", `vsid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { revoke(sidFrom(req)); res.json({ ok: true }); });

app.get("/api/config", (_req, res) => res.json(redacted()));

const cleanPeer = (x) => ({ server: String(x?.server || "").replace(/\/+$/, ""), clientId: String(x?.clientId || ""), clientSecret: String(x?.clientSecret || ""), master: String(x?.master || "") });
const normSchedule = (s) => {
  if (s?.kind === "interval") return { kind: "interval", hours: Math.max(1, Number(s.hours) || 24) };
  if (s?.kind === "manual") return { kind: "manual" };
  const at = /^\d{2}:\d{2}$/.test(s?.at || "") ? s.at : "04:17";
  return { kind: "daily", at };
};
const clampRetention = (n) => Math.min(60, Math.max(1, Number(n) || 7));

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  if (b.direction && !["A>B", "B>A"].includes(b.direction)) return res.status(400).json({ error: "direction must be A>B or B>A (bidirectional is on the roadmap)" });
  const c = structuredClone(cfg);
  c.direction = b.direction || c.direction;
  c.method = ["mirror", "archive-only"].includes(b.method) ? b.method : c.method;
  c.schedule = b.schedule ? normSchedule(b.schedule) : c.schedule;
  c.retention = b.retention ? clampRetention(b.retention) : c.retention;
  for (const k of ["A", "B"]) {
    const inc = b[k.toLowerCase()];
    const old = c.peers[k] || {};
    c.peers[k] = {
      server: inc?.server?.trim() ? inc.server.trim().replace(/\/+$/, "") : old.server || "",
      clientId: inc?.clientId ? inc.clientId.trim() : old.clientId || "",
      clientSecret: inc?.clientSecret ? inc.clientSecret.trim() : old.clientSecret || "",
      master: inc?.master ? inc.master : old.master || "",
    };
  }
  if (b.adminPassword) {
    if (String(b.adminPassword).length < 8) return res.status(400).json({ error: "admin password >= 8 chars" });
    c.admin = { ...c.admin, passhash: hashPw(String(b.adminPassword)) };
  }
  cfg = c;
  saveConfig(cfg);
  res.json({ ok: true, config: redacted() });
});

app.post("/api/test", async (req, res) => {
  const { peer, server, clientId, clientSecret, master, useStored } = req.body || {};
  const stored = cfg.peers[peer === "B" ? "B" : "A"] || {};
  const p = {
    server: (useStored ? "" : server) || stored.server,
    clientId: (useStored ? "" : clientId) || stored.clientId,
    clientSecret: (useStored ? "" : clientSecret) || stored.clientSecret,
    master: (useStored ? "" : master) || stored.master,
  };
  if (!p.server || !p.clientId || !p.clientSecret || !p.master) return res.status(400).json({ error: "server/clientId/clientSecret/master all required" });
  try {
    const c = bwClient(p);
    await c.open();
    await c.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

app.post("/api/run", async (_req, res) => {
  if (running) return res.status(409).json({ error: "already running" });
  running = true;
  res.json({ ok: true, started: new Date().toISOString() });
  try {
    log("=== manual run ===");
    await runOnce({ cfg, dirs, log });
  } catch (e) { log("FATAL " + e.message); }
  finally { running = false; }
});

app.post("/api/2fa/enroll", (_req, res) => {
  const secret = newTotpSecret();
  cfg.admin = { ...cfg.admin, totp: { secret, enabled: false } };
  saveConfig(cfg);
  res.json({ secret, url: totpUrl(secret, "vault-sync") });
});

app.post("/api/2fa/enable", (req, res) => {
  const sec = cfg.admin?.totp?.secret;
  if (!sec) return res.status(400).json({ error: "enroll first" });
  if (!totpCheck(sec, String(req.body?.code || ""))) return res.status(400).json({ error: "bad code" });
  cfg.admin.totp.enabled = true;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post("/api/2fa/disable", (_req, res) => {
  if (cfg.admin?.totp) { delete cfg.admin.totp; saveConfig(cfg); }
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  let state = { lastRun: null };
  try { state = JSON.parse(fs.readFileSync(STATEFILE, "utf8")); } catch {}
  res.json({ state, running, nextRun: nextRunAt(), keyFromUSB: keyMaterial().fromUSB });
});

app.get("/api/logs", (req, res) => {
  const bytes = Math.min(200000, Number(req.query.bytes) || 16000);
  try {
    const buf = fs.readFileSync(LOGFILE);
    res.json({ text: buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8") });
  } catch { res.json({ text: "" }); }
});

function nextRunAt() {
  const s = cfg?.schedule || { kind: "daily", at: "04:17" };
  if (s.kind === "manual") return null;
  let last = null;
  try { last = new Date(JSON.parse(fs.readFileSync(STATEFILE, "utf8")).lastRun.ts); } catch {}
  if (s.kind === "interval") return last ? new Date(last.getTime() + s.hours * 3600e3).toISOString() : new Date().toISOString();
  const [hh, mm] = s.at.split(":").map(Number);
  const t = new Date(); t.setHours(hh, mm, 0, 0);
  if (last && last >= t) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

setInterval(async () => {
  if (!cfg || running) return;
  const due = (() => {
    const s = cfg.schedule || { kind: "manual" };
    let last = null;
    try { last = new Date(JSON.parse(fs.readFileSync(STATEFILE, "utf8")).lastRun.ts); } catch {}
    if (s.kind === "daily") {
      const [hh, mm] = s.at.split(":").map(Number);
      const t = new Date(); t.setHours(hh, mm, 0, 0);
      return (!last || last < t) && Date.now() >= t.getTime();
    }
    if (s.kind === "interval") return !last || Date.now() - last.getTime() > s.hours * 3600e3;
    return false;
  })();
  if (!due) return;
  running = true;
  try { log("=== scheduled run ==="); await runOnce({ cfg, dirs, log }); }
  catch (e) { log("FATAL " + e.message); }
  finally { running = false; }
}, 60000);

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`vault-sync listening on ${PORT} (setup: ${cfg ? "done" : "PENDING"})`));
