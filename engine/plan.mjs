const clean = (v) => {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== null);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      const c = clean(v[k]);
      if (c === null || c === undefined || c === "" || (Array.isArray(c) && c.length === 0)) continue;
      o[k] = c;
    }
    return o;
  }
  return v;
};
const DROP = ["id", "organizationId", "collectionId", "attachments", "passwordHistory", "repid", "creationDate", "revisionDate", "reprompt", "key", "mac", "object"];
const norm = (i, folderId) => {
  const c = JSON.parse(JSON.stringify(i));
  for (const k of DROP) delete c[k];
  c.folderId = folderId ?? null;
  return JSON.stringify(clean(c));
};
const isId = (x) => typeof x === "string" && x.length >= 32;

export function planSync({ src, tgtItems, tgtFolders, map }) {
  map.items = map.items || {};
  map.folders = map.folders || {};
  const cloudItemById = new Map(tgtItems.map((i) => [i.id, i]));
  const cloudFolderByName = new Map();
  for (const f of tgtFolders) if (!cloudFolderByName.has(f.name)) cloudFolderByName.set(f.name, f);

  const plan = { creF: [], delF: [], cre: [], upd: [], del: [] };
  const srcFolders = Object.fromEntries((src.folders || []).map((f) => [f.id, f.name]));

  for (const f of tgtFolders) {
    if (Object.values(map.folders).includes(f.id)) continue;
    const skey = Object.keys(srcFolders).find((k) => srcFolders[k] === f.name);
    if (skey) map.folders[skey] = f.id;
    else if (isId(f.id)) plan.delF.push(f.id);
  }
  for (const [sid, name] of Object.entries(srcFolders)) if (!map.folders[sid]) plan.creF.push({ sid, name });

  const srcIds = new Set(src.items.map((i) => i.id));
  const tgtUsed = new Set(Object.values(map.items));
  const srcByName = new Map();
  for (const it of src.items) {
    srcIds.add(it.id);
    if (map.items[it.id] && cloudItemById.has(map.items[it.id])) continue;
    const a = srcByName.get(it.name) || [];
    a.push(it);
    srcByName.set(it.name, a);
  }
  const tgtByName = new Map();
  for (const i of tgtItems) {
    if (tgtUsed.has(i.id)) continue;
    const a = tgtByName.get(i.name) || [];
    a.push(i);
    tgtByName.set(i.name, a);
  }
  for (const [name, sgrp] of srcByName) {
    const tgrp = (tgtByName.get(name) || []).sort((a, b) => String(a.creationDate || a.id).localeCompare(String(b.creationDate || b.id)));
    sgrp.sort((a, b) => String(a.creationDate || a.id).localeCompare(String(b.creationDate || b.id)));
    sgrp.forEach((it, k) => {
      if (tgrp[k]) map.items[it.id] = tgrp[k].id;
      else plan.cre.push({ it, cf: it.folderId ? map.folders[it.folderId] ?? null : null });
    });
  }
  for (const it of src.items) {
    if (plan.cre.some((c) => c.it === it)) continue;
    const cf = it.folderId ? map.folders[it.folderId] ?? null : null;
    const cid = map.items[it.id];
    if (cid && cloudItemById.has(cid)) {
      const cur = cloudItemById.get(cid);
      if (norm(it, cf) !== norm(cur, cur.folderId)) {
        const a = JSON.parse(norm(it, cf)), b = JSON.parse(norm(cur, cur.folderId));
        const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        plan.upd.push({ cid, it, cf, diffs });
      }
    }
  }
  for (const [sid, cid] of Object.entries(map.items)) {
    if (!srcIds.has(sid)) {
      if (cloudItemById.has(cid) && isId(cid)) plan.del.push(cid);
      delete map.items[sid];
    }
  }
  for (const sid of Object.keys(map.folders)) if (!srcFolders[sid]) delete map.folders[sid];
  return plan;
}

export const payload = (it, cf) => {
  const c = JSON.parse(JSON.stringify(it));
  for (const k of DROP) delete c[k];
  c.folderId = cf;
  return JSON.stringify(clean(c));
};
export const summary = (p) => `folders +${p.creF.length}/-${p.delF.length} items +${p.cre.length}/~${p.upd.length}/-${p.del.length} attachments-skipped:${p.cre.concat(p.upd).filter((j) => (j.it.attachments || []).length).length}`;
