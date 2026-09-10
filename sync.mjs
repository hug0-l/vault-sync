import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
const x = promisify(execFile);
const OPT = { maxBuffer: 64 * 1024 * 1024, timeout: 60000 };
const SRC = JSON.parse(fs.readFileSync(process.env.PLAIN_FILE, "utf8"));
const MAPFILE = process.env.MAP_FILE;
let map = { items: {}, folders: {} };
try { map = JSON.parse(fs.readFileSync(MAPFILE, "utf8")); } catch {}
map.items = map.items || {}; map.folders = map.folders || {};
const log = (...a) => console.log("[sync]", ...a);
const bw = (args, input) => x("bw", [...args, "--nointeraction"], input === undefined ? OPT : { ...OPT, input });

try { await bw(["sync"]); } catch (e) { log("sync failed (continuing):", e.message); }
const j = async (args) => JSON.parse((await bw(args)).stdout || "[]");
const cloudItems = await j(["list", "items"]);
const cloudFolders = await j(["list", "folders"]);
const cloudItemById = new Map(cloudItems.map(i => [i.id, i]));

const isId = (x) => typeof x === "string" && x.length >= 32;
const clean = (v) => {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== null);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) { const c = clean(v[k]); if (c === null || c === undefined || c === "" || (Array.isArray(c) && c.length === 0)) continue; o[k] = c; } return o; }
  return v;
};
const norm = (i, folderId) => {
  const c = JSON.parse(JSON.stringify(i));
  for (const k of ["id", "organizationId", "collectionId", "attachments", "passwordHistory", "repid", "creationDate", "revisionDate", "reprompt", "key", "mac", "object"]) delete c[k];
  c.folderId = folderId ?? null;
  return JSON.stringify(clean(c));
};

const srcFolders = Object.fromEntries((SRC.folders || []).map(f => [f.id, f.name]));
const plan = { creF: [], delF: [], cre: [], upd: [], del: [] };
for (const f of cloudFolders) {
  if (Object.values(map.folders).includes(f.id)) continue;
  const skey = Object.keys(srcFolders).find(k => srcFolders[k] === f.name);
  if (skey && !Object.values(map.folders).includes(f.id)) map.folders[skey] = f.id;
  else if (isId(f.id)) plan.delF.push(f.id);
}
for (const [sid, name] of Object.entries(srcFolders)) {
  if (!map.folders[sid]) plan.creF.push({ sid, name });
}

const byName = new Map();
for (const i of cloudItems) { const a = byName.get(i.name) || []; a.push(i); byName.set(i.name, a); }
const srcIds = new Set();
for (const it of SRC.items) {
  srcIds.add(it.id);
  const cf = it.folderId ? map.folders[it.folderId] ?? null : null;
  let cid = map.items[it.id];
  if (cid && !cloudItemById.has(cid)) cid = null;
  if (!cid) {
    const c = (byName.get(it.name) || []).filter(x2 => !Object.values(map.items).includes(x2.id));
    if (c.length === 1) cid = c[0].id;
  }
  if (!cid) plan.cre.push({ it, cf });
  else {
    map.items[it.id] = cid;
    const cur = cloudItemById.get(cid);
    if (norm(it, cf) !== norm(cur, cur.folderId)) {
      if (process.env.DEBUG_DIFF && plan.upd.length < 3) {
        const a = JSON.parse(norm(it, cf)), b = JSON.parse(norm(cur, cur.folderId));
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) log("DIFF", it.name.slice(0, 20), k, "src=" + JSON.stringify(a[k])?.slice(0, 90), "cloud=" + JSON.stringify(b[k])?.slice(0, 90));
      }
      plan.upd.push({ cid, it, cf });
    }
  }
}
for (const [sid, cid] of Object.entries(map.items)) {
  if (!srcIds.has(sid)) { if (cloudItemById.has(cid) && isId(cid)) plan.del.push(cid); delete map.items[sid]; }
}
for (const sid of Object.keys(map.folders)) if (!srcFolders[sid]) delete map.folders[sid];

log(`plan: folders +${plan.creF.length}/-${plan.delF.length} items +${plan.cre.length}/~${plan.upd.length}/-${plan.del.length} skipped-attachments:${SRC.items.filter(i => (i.attachments || []).length).length}`);

const strip = (it, cf) => { const c = JSON.parse(JSON.stringify(it)); for (const k of ["id","attachments","passwordHistory","reprompt","creationDate","revisionDate","organizationId","collectionId","key","mac","object"]) delete c[k]; c.folderId = cf; return JSON.stringify(clean(c)); };
let errs = 0, done = 0;
const enc = async (obj) => Buffer.from(obj).toString("base64");
const jobs = [
  ...plan.creF.map(f => async () => { const r = await bw(["create", "folder", await enc(JSON.stringify({ name: f.name }))]); if (r) { map.folders[f.sid] = JSON.parse(r.stdout).id; done++; } }),
  ...plan.delF.map(id => async () => { if (await bw(["delete", "folder", id])) done++; }),
  ...plan.cre.map(({ it, cf }) => async () => { const r = await bw(["create", "item", await enc(strip(it, cf))]); if (r) { map.items[it.id] = JSON.parse(r.stdout).id; done++; } }),
  ...plan.upd.map(({ cid, it, cf }) => async () => { if (await bw(["edit", "item", cid, await enc(strip(it, cf))])) done++; }),
  ...plan.del.map(id => async () => { if (await bw(["delete", "item", id, "--permanent"])) done++; }),
];
if (process.env.DRY_RUN) { save0(); process.exit(0); }
function save0() { fs.writeFileSync(MAPFILE + ".tmp", JSON.stringify(map)); fs.renameSync(MAPFILE + ".tmp", MAPFILE); }
const save = () => { fs.writeFileSync(MAPFILE + ".tmp", JSON.stringify(map)); fs.renameSync(MAPFILE + ".tmp", MAPFILE); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let i = 0, since = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  while (i < jobs.length) {
    const before = done + errs;
    try { await jobs[i++](); }
    catch (e) { errs++; log("ERR", ((e.stderr || "") + " " + (e.message || "")).replace(/\s+/g, " ").slice(0, 280)); }
    if (done + errs === before) { log("no progress, backing off 30s"); await sleep(30000); }
    else if (++since >= 25) { save(); since = 0; }
    await sleep(200);
  }
}));
save();
log(`applied ${done}/${jobs.length} ops, errors: ${errs}`);
if (done + errs === 0 && jobs.length > 0) process.exit(1);
if (errs > Math.max(10, jobs.length * 0.1)) process.exit(1);
