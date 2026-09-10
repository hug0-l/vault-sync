import { payload } from "./plan.mjs";
const b64 = (s) => Buffer.from(s).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function applyPlan(client, plan, { onProgress, onErr, concurrency = 2 } = {}) {
  let errs = 0, done = 0;
  const jobs = [
    ...plan.creF.map((f) => async () => {
      const r = await client.raw(["create", "folder", b64(JSON.stringify({ name: f.name }))]);
      f._result = JSON.parse(r).id; done++;
    }),
    ...plan.delF.map((id) => async () => { await client.raw(["delete", "folder", id]); done++; }),
    ...plan.cre.map((j) => async () => {
      const r = await client.raw(["create", "item", b64(payload(j.it, j.cf))]);
      j._result = JSON.parse(r).id; done++;
    }),
    ...plan.upd.map((j) => async () => {
      await client.raw(["edit", "item", j.cid, b64(payload(j.it, j.cf))]);
      done++;
    }),
    ...plan.del.map((id) => async () => { await client.raw(["delete", "item", id, "--permanent"]); done++; }),
  ];
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < jobs.length) {
        const before = done + errs;
        try { await jobs[i++](); }
        catch (e) { errs++; onErr && onErr(e.message); }
        if (done + errs === before) { onErr && onErr("no progress, backing off 30s"); await sleep(30000); }
        else if (onProgress) onProgress(done + errs, jobs.length);
        await sleep(200);
      }
    })
  );
  return { done, errs, total: jobs.length };
}
