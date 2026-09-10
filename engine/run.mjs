import fs from "fs";
import path from "path";
import os from "os";
import { bwClient } from "./bw.mjs";
import { planSync, summary } from "./plan.mjs";
import { applyPlan } from "./apply.mjs";

const readMap = (f) => {
  if (!fs.existsSync(f)) return { format: 2, buckets: {} };
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (j.format === 2) return j;
  return { format: 2, buckets: { "A>B": j } };
};
const writeMap = (f, m) => { fs.writeFileSync(f + ".tmp", JSON.stringify(m)); fs.renameSync(f + ".tmp", f); };

export async function runOnce({ cfg, dirs, log = () => {} }) {
  const t0 = Date.now();
  const dirKey = cfg.direction === "B>A" ? "B>A" : "A>B";
  const srcPeer = cfg.direction === "B>A" ? cfg.peers.B : cfg.peers.A;
  const tgtPeer = cfg.direction === "B>A" ? cfg.peers.A : cfg.peers.B;
  if (!srcPeer || !srcPeer.server) throw new Error("source peer not configured");
  if (cfg.method === "mirror" && (!tgtPeer || !tgtPeer.clientId)) throw new Error("target peer not configured");

  const date = new Date().toISOString().slice(0, 10);
  const tag = dirKey === "A>B" ? "AB" : "BA";
  const archive = path.join(dirs.backups, `vault-${tag}-${date}.json`);

  const src = bwClient(srcPeer);
  await src.open();
  log("source session open");
  await src.raw(["export", "--format", "encrypted_json", "--password", cfg.filepw, "--output", archive]);
  log(`archive written ${path.basename(archive)}`);
  let snapshot = null;
  if (cfg.method === "mirror") {
    const pl = path.join(os.tmpdir(), `vault-sync-${process.pid}.json`);
    await src.raw(["export", "--format", "json", "--output", pl]);
    snapshot = JSON.parse(fs.readFileSync(pl, "utf8"));
    fs.rmSync(pl, { force: true });
    log(`source snapshot: ${snapshot.items.length} items / ${(snapshot.folders || []).length} folders (RAM only)`);
  }
  await src.close();

  const result = { ts: new Date().toISOString(), durationMs: 0, direction: cfg.direction, method: cfg.method, plan: null, applied: 0, errors: 0, ok: true };

  if (cfg.method === "archive-only") {
    prune(archive, dirs.backups, cfg.retention || 7);
    result.durationMs = Date.now() - t0;
    finish(result, dirs);
    return result;
  }

  const mapFile = path.join(dirs.backups, "mapping.json");
  const all = readMap(mapFile);
  all.buckets[dirKey] = all.buckets[dirKey] || { items: {}, folders: {} };
  const map = all.buckets[dirKey];
  const otherKey = dirKey === "A>B" ? "B>A" : "A>B";
  const other = all.buckets[otherKey];
  if (!Object.keys(map.items).length && other && Object.keys(other.items || {}).length) {
    map.items = Object.fromEntries(Object.entries(other.items).map(([k, v]) => [v, k]));
    map.folders = Object.fromEntries(Object.entries(other.folders || {}).map(([k, v]) => [v, k]));
    log("mapping inverted from reverse-direction bucket");
  }

  const tgt = bwClient(tgtPeer);
  await tgt.open();
  await tgt.raw(["sync"]);
  const tgtItems = await tgt.list("items");
  const tgtFolders = await tgt.list("folders");
  log(`target snapshot: ${tgtItems.length} items`);
  const plan = planSync({ src: snapshot, tgtItems, tgtFolders, map });
  result.plan = { cre: plan.cre.length, upd: plan.upd.length, del: plan.del.length, creF: plan.creF.length, delF: plan.delF.length };
  log(`plan: ${summary(plan)}`);
  if (process.env.DRY_RUN) {
    log("DRY_RUN — plan computed, nothing applied");
    await tgt.close();
    result.applied = 0; result.dry = true;
    result.durationMs = Date.now() - t0;
    finish(result, dirs);
    return result;
  }
  let since = 0;
  const r = await applyPlan(tgt, plan, {
    onProgress: () => { if (++since >= 25) { since = 0; writeMap(mapFile, all); } },
    onErr: (m) => log("ERR " + m),
  });
  writeMap(mapFile, all);
  await tgt.close();
  log(`applied ${r.done}/${r.total} ops, errors: ${r.errs}`);
  prune(archive, dirs.backups, cfg.retention || 7);
  result.applied = r.done;
  result.errors = r.errs;
  result.ok = r.errs === 0;
  result.durationMs = Date.now() - t0;
  finish(result, dirs);
  return result;
}

function prune(latest, dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => /^vault(-(AB|BA)|warden)-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  for (const f of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
}

function finish(result, dirs) {
  fs.writeFileSync(path.join(dirs.data, "state.json") + ".tmp", JSON.stringify({ lastRun: result }));
  fs.renameSync(path.join(dirs.data, "state.json") + ".tmp", path.join(dirs.data, "state.json"));
}
