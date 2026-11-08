// Permissions the machine holds for the owner (src/machine-perms.ts, MachineStore.permission) and the wake of a finished
// thread (src/machine-wake.ts). Run: node test/machine-perms.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "perms-"));
let machine, cloud, waiting, wake, perms;
try {
  await build({ entryPoints: ["src/machine.ts", "src/cloud-tasks.ts", "src/waiting.ts", "src/machine-wake.ts", "src/machine-perms.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [machine, cloud, waiting, wake, perms] = await Promise.all([load("machine"), load("cloud-tasks"), load("waiting"), load("machine-wake"), load("machine-perms")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function paired() {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  const atomic = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const tasks = new cloud.TaskStore(sql);
  const store = new machine.MachineStore(sql, tasks, atomic);
  const { code } = await store.code();
  const { token } = await store.register({ label: "VPS", code }, false);
  await store.heartbeat(token);
  const added = tasks.add({ title: "Synthetic", job: "job text", execution: "machine" });
  store.enqueue(added.task, "job", "job text");
  const { work } = await store.poll(token, { claimKey: "ck_aaaaaaaa" });
  return { db, tasks, store, token, work, task: added.task };
}
const held = (work, extra = {}) => ({ workId: work.workId, token: work.token, id: "p_0123456789", state: "held", title: "Run scutil", kind: "other", detail: "scutil --get ComputerName", ...extra });
const status = (error, code) => (e) => e instanceof machine.MachineError && e.status === error && e.code === code;

await test("a held permission is listed with Allow / Deny, and only the owner's answer goes back in the poll", async () => {
  const f = await paired();
  assert.deepEqual(await f.store.permission(f.token, held(f.work)), { ok: true });
  await f.store.permission(f.token, held(f.work)); // a repeat changes nothing
  const list = waiting.build({ asks: [], perms: f.store.perms.pending(), notes: [], threads: [{ id: f.work.thread, taskId: f.task.id, title: "T", status: "working", runs: "machine", summary: "", choices: [], reason: "", waiting: false, updatedAt: Date.now() }], seen: new Set(), now: Date.now() });
  assert.equal(list.items.length, 1);
  assert.deepEqual([list.items[0].kind, list.items[0].perm, list.items[0].line, list.items[0].detail, list.items[0].thread], ["permission", "p_0123456789", "Run scutil", "scutil --get ComputerName", f.work.thread]);
  assert.deepEqual((await f.store.poll(f.token, { claimKey: "ck_aaaaaaaa" })).answers, [], "nothing answered yet");
  assert.equal(f.store.perms.answer("p_0123456789", true), true);
  assert.equal(f.store.perms.answer("p_0123456789", false), false, "answered once");
  assert.deepEqual((await f.store.poll(f.token, { claimKey: "ck_bbbbbbbb" })).answers, [{ id: "p_0123456789", allow: true }]);
  assert.deepEqual(f.store.perms.pending(), []);
  await f.store.permission(f.token, { workId: f.work.workId, token: f.work.token, id: "p_0123456789", state: "closed" });
  assert.deepEqual((await f.store.poll(f.token, { claimKey: "ck_cccccccc" })).answers, [], "closed by the runner");
});

await test("a decision on the desktop (closed) clears the item; a turn that ends clears what it held", async () => {
  const f = await paired();
  await f.store.permission(f.token, held(f.work));
  await f.store.permission(f.token, { workId: f.work.workId, token: f.work.token, id: "p_0123456789", state: "closed" });
  assert.deepEqual(f.store.perms.pending(), []);
  await f.store.permission(f.token, held(f.work, { id: "p_aaaaaaaaaa" }));
  const done = await f.store.receipt(f.token, { receiptId: `${f.work.workId}:final`, workId: f.work.workId, token: f.work.token, type: "final", status: "done", summary: "ok" });
  assert.deepEqual(f.store.perms.pending(), []);
  assert.equal(done.finished.kind, "job");
  await f.store.permission(f.token, held(f.work, { id: "p_bbbbbbbbbb" })).then((answer) => assert.deepEqual(answer, { ok: true, ignored: true }), "a finished work holds nothing");
  assert.deepEqual(f.store.perms.pending(), []);
});

await test("the 10-minute timeout clears an unanswered item", async () => {
  const f = await paired();
  await f.store.permission(f.token, held(f.work));
  assert.equal(f.store.perms.pending().length, 1);
  const now = Date.now;
  try { Date.now = () => now() + 12 * 60_000; assert.deepEqual(f.store.perms.pending(), []); assert.equal(f.store.perms.answer("p_0123456789", true), false); }
  finally { Date.now = now; }
});

await test("strict reports: unknown fields, bad ids, wrong token, the runner's own token", async () => {
  const f = await paired();
  await assert.rejects(f.store.permission(f.token, held(f.work, { cwd: "/" })), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { id: "x" })), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { title: "" })), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { kind: "Other!" })), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission(f.token, { workId: f.work.workId, token: f.work.token, id: "p_0123456789", state: "closed", title: "x" }), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { token: "wt_wrong" })), status(409, "INVALID_TOKEN"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { workId: "w_nope" })), status(409, "UNKNOWN_WORK"));
  await assert.rejects(f.store.permission(f.token, held(f.work, { detail: `leak ${f.token}` })), status(400, "INVALID_PERMISSION"));
  await assert.rejects(f.store.permission("rr_" + "0".repeat(64), held(f.work)), status(401, "UNAUTHORIZED"));
  assert.deepEqual(f.store.perms.pending(), []);
  assert.equal(perms.parsePermReport(held(f.work, { detail: "x".repeat(900) })).detail.length, 400);
});

await test("another work cannot close a permission it did not report", async () => {
  const f = await paired();
  await f.store.permission(f.token, held(f.work));
  f.store.perms.closed("w_other", "p_0123456789");
  assert.equal(f.store.perms.pending().length, 1);
});

await test("a finished job or mail wakes the resident once; say, stopped and waiting do not", () => {
  for (const kind of ["job", "mail"]) for (const status of ["done", "failed"]) assert.equal(wake.wakesResident({ kind, status }), true, `${kind} ${status}`);
  for (const [kind, status] of [["say", "done"], ["say", "failed"], ["job", "stopped"], ["job", "needs_you"], ["mail", "needs_you"]]) assert.equal(wake.wakesResident({ kind, status }), false, `${kind} ${status}`);
});
