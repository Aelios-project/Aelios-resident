// The one-time grant on an approval that ran out of time (src/machine-grant.ts, MachineStore). Run: node test/machine-grant.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "grant-"));
let machine, cloud, waiting;
try {
  await build({ entryPoints: ["src/machine.ts", "src/cloud-tasks.ts", "src/waiting-store.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [machine, cloud, waiting] = await Promise.all([load("machine"), load("cloud-tasks"), load("waiting-store")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const GRANT = "g_0123456789";

async function fixture(db = new DatabaseSync(":memory:")) {
  const sql = (strings, ...values) => { const stmt = db.prepare(strings.join("?")); return /^\s*SELECT/i.test(strings[0]) ? stmt.all(...values) : (stmt.run(...values), []); };
  const tasks = new cloud.TaskStore(sql);
  const atomic = (fn) => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const store = new machine.MachineStore(sql, tasks, atomic);
  const { token } = await store.register({ label: "Synthetic machine" }, true);
  await store.heartbeat(token);
  const { task } = tasks.add({ title: "Synthetic job", job: "Synthetic work", execution: "machine" });
  store.enqueue(task, "job", task.job);
  const { work } = await store.poll(token, { claimKey: "grant_claim_1" });
  const receipt = (ask) => ({ receiptId: work.workId + ":final", workId: work.workId, token: work.token, type: "final", status: "needs_you", summary: "Held and not answered.", ask: { key: "perm:abc", question: "The helper wanted to run git push.", ...ask } });
  return { db, sql, tasks, atomic, store, token, task, work, receipt };
}

await test("the heartbeat lists job.grant", async () => {
  const f = await fixture();
  assert.ok((await f.store.heartbeat(f.token)).accepts.includes("job.grant"));
});

await test("an approval ask keeps its grant for her 允许 only, never on the page", async () => {
  const f = await fixture();
  await f.store.receipt(f.token, f.receipt({ kind: "permission", grant: GRANT }));
  assert.equal((await f.store.receipt(f.token, f.receipt({ kind: "permission", grant: GRANT }))).duplicate, true);
  await assert.rejects(f.store.receipt(f.token, f.receipt({ kind: "permission", grant: "g_9999999999" })), (error) => error.status === 409, "the grant is part of the receipt");
  assert.equal(f.store.grantFor(f.task.root, f.task.id), GRANT);
  assert.equal(f.store.grantFor(f.task.root, "other-task"), "");
  assert.ok(!JSON.stringify(f.store.asks(f.task.root)).includes(GRANT), "the thread page does not get it");
  assert.ok(!JSON.stringify(f.store.allAsks()).includes(GRANT));
  assert.ok(!JSON.stringify(new waiting.WaitingStore(f.sql, f.tasks, f.store).list()).includes(GRANT), "the waiting list does not get it");
  f.store.answered(f.task.root, f.task.id);
  assert.equal(f.store.grantFor(f.task.root, f.task.id), "", "gone with the ask");
});

await test("a grant that is not well formed, or not on an approval, is refused before anything is stored", async () => {
  const f = await fixture();
  for (const ask of [{ kind: "permission", grant: "g_123" }, { kind: "permission", grant: "G_0123456789" }, { kind: "permission", grant: 42 }, { kind: "permission", grant: null }, { kind: "question", grant: GRANT }, { grant: GRANT }]) {
    const reply = await machine.machineReply(() => f.store.receipt(f.token, f.receipt(ask)));
    assert.equal(reply.status, 400, JSON.stringify(ask));
    assert.equal(reply.body.code, "INVALID_RECEIPT");
  }
  assert.deepEqual(f.store.asks(f.task.root), []);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM res_machine_receipts").get().n, 0);
});

await test("an approval without a grant offers none", async () => {
  const f = await fixture();
  await f.store.receipt(f.token, f.receipt({ kind: "permission" }));
  assert.equal(f.store.grantFor(f.task.root, f.task.id), "");
});

await test("the follow-up carries the grant to the runner; other work and a cancel never do", async () => {
  const f = await fixture();
  await f.store.receipt(f.token, f.receipt({ kind: "permission", grant: GRANT }));
  const [follow] = f.tasks.thread(f.task.root);
  const added = f.tasks.add({ title: "Synthetic job", job: "允许", execution: "machine", follows: follow.id, direct: true });
  f.store.enqueue(added.task, "say", "允许", [], null, GRANT);
  const { work } = await f.store.poll(f.token, { claimKey: "grant_claim_2" });
  assert.equal(work.grant, GRANT);
  assert.equal(work.kind, "say");
  const again = await f.store.poll(f.token, { claimKey: "grant_claim_2" });
  assert.equal(again.work.grant, GRANT, "a replayed claim carries it too");
  f.store.enqueue(added.task, "cancel", "", [], null, GRANT);
  const cancel = (await f.store.poll(f.token, { claimKey: "grant_claim_3", accept: ["cancel"] })).work;
  assert.equal(cancel.kind, "cancel");
  assert.equal(Object.hasOwn(cancel, "grant"), false);
  const plain = f.tasks.add({ title: "Plain", job: "Plain work", execution: "machine" });
  f.store.enqueue(plain.task, "job", "Plain work");
  await f.store.receipt(f.token, { receiptId: work.workId + ":final", workId: work.workId, token: work.token, type: "final", status: "done", summary: "Done." });
  const next = (await f.store.poll(f.token, { claimKey: "grant_claim_4" })).work;
  assert.equal(Object.hasOwn(next, "grant"), false);
});

await test("old tables get the grant columns once and keep working", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE res_machine_work (work_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, token TEXT NOT NULL, task_id TEXT NOT NULL,
    thread TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, claim_key TEXT NOT NULL, lease_until INTEGER, created_at INTEGER NOT NULL, files TEXT NOT NULL DEFAULT '[]')`);
  db.exec("INSERT INTO res_machine_work VALUES ('w_old', 'm', 't', 'task', 'thread', 'job', 'old', 'done', '', NULL, 1, '[]')");
  db.exec("CREATE TABLE res_machine_asks (thread TEXT NOT NULL, key TEXT NOT NULL, task_id TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, recommend TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT '', PRIMARY KEY(thread, key))");
  db.exec("INSERT INTO res_machine_asks VALUES ('old', 'old-key', 'old-task', 'Old question?', '[]', '', 1, 'permission')");
  const f = await fixture(db);
  assert.equal(f.store.grantFor("old", "old-task"), "", "an old approval has no grant");
  assert.equal(db.prepare("SELECT grant_id FROM res_machine_work WHERE work_id = 'w_old'").get().grant_id, "");
  await f.store.receipt(f.token, f.receipt({ kind: "permission", grant: GRANT }));
  assert.equal(f.store.grantFor(f.task.root, f.task.id), GRANT);
});
