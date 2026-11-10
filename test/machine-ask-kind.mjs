import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync("node_modules/.cache/ask-kind-");
let machine, cloud, waiting;
try {
  await build({ entryPoints: ["src/machine.ts", "src/cloud-tasks.ts", "src/waiting-store.ts"], outdir: dir, bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" }, logLevel: "error" });
  [machine, cloud, waiting] = await Promise.all(["machine", "cloud-tasks", "waiting-store"].map(name => import(pathToFileURL(resolve(dir, name + ".mjs")).href)));
} finally { rmSync(dir, { recursive: true, force: true }); }

async function fixture(db = new DatabaseSync(":memory:")) {
  const sql = (strings, ...values) => { const stmt = db.prepare(strings.join("?")); return /^\s*SELECT/i.test(strings[0]) ? stmt.all(...values) : (stmt.run(...values), []); };
  const tasks = new cloud.TaskStore(sql);
  const atomic = fn => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const store = new machine.MachineStore(sql, tasks, atomic);
  const { token } = await store.register({ label: "Synthetic machine" }, true);
  assert.ok((await store.heartbeat(token)).accepts.includes("ask.kind"));
  const { task } = tasks.add({ title: "Synthetic job", job: "Synthetic work", execution: "machine" });
  store.enqueue(task, "job", task.job);
  const { work } = await store.poll(token, { claimKey: "ask_kind_claim" });
  const receipt = kind => ({ receiptId: work.workId + ":final", workId: work.workId, token: work.token, type: "final", status: "needs_you", summary: "Input required.", ask: { key: "decision", question: "Continue?", ...(kind === undefined ? {} : { kind }) } });
  return { db, sql, tasks, atomic, store, token, task, receipt };
}

for (const kind of ["permission", "question", undefined]) {
  await test(`ask kind ${kind ?? "absent"} survives receipts, replay, storage and waiting`, async () => {
    const f = await fixture();
    await f.store.receipt(f.token, f.receipt(kind));
    assert.equal((await f.store.receipt(f.token, f.receipt(kind))).duplicate, true);
    const restored = new machine.MachineStore(f.sql, f.tasks, f.atomic);
    const ask = restored.asks(f.task.root)[0];
    assert.equal(ask.kind, kind);
    assert.equal(Object.hasOwn(ask, "kind"), kind !== undefined);
    assert.equal(restored.allAsks()[0].kind, kind);
    const item = new waiting.WaitingStore(f.sql, f.tasks, restored).list().items[0];
    assert.equal(item.kind, "ask", "receipt subtypes do not create live permission handles");
    assert.equal(item.askKind, kind);
    assert.equal(item.perm, undefined);
    assert.equal(Object.hasOwn(item, "askKind"), kind !== undefined);
    if (kind) await assert.rejects(f.store.receipt(f.token, f.receipt(kind === "permission" ? "question" : "permission")), error => error.status === 409);
  });
}

await test("bad kind values return 400 without storing a final or an ask", async () => {
  const f = await fixture();
  for (const kind of ["problem", "", "Permission", null, 42, {}, []]) {
    const reply = await machine.machineReply(() => f.store.receipt(f.token, f.receipt(kind)));
    assert.equal(reply.status, 400);
    assert.equal(reply.body.code, "INVALID_RECEIPT");
  }
  assert.deepEqual(f.store.asks(f.task.root), []);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM res_machine_receipts").get().n, 0);
});

await test("old ask tables migrate once and existing unresolved asks keep no kind", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE res_machine_asks (thread TEXT NOT NULL, key TEXT NOT NULL, task_id TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, recommend TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(thread, key))");
  db.exec("INSERT INTO res_machine_asks VALUES ('old', 'old-key', 'old-task', 'Old question?', '[]', '', 1)");
  const f = await fixture(db);
  new machine.MachineStore(f.sql, f.tasks, f.atomic);
  assert.equal(f.store.asks("old")[0].kind, undefined);
  await f.store.receipt(f.token, f.receipt("permission"));
  assert.equal(f.store.asks(f.task.root)[0].kind, "permission", "named-column insert works after migration");
});

await test("waiting and thread labels distinguish approval and answers while absent kind keeps old labels", () => {
  const context = vm.createContext({});
  for (const file of ["public/machine-ask-kind.js", "public/waiting.js"]) vm.runInContext(readFileSync(file, "utf8"), context);
  const page = vm.runInContext("waitingPage()", context);
  const label = vm.runInContext("machineThreadAskLabel", context);
  assert.equal(page.waitingKind({ kind: "ask", askKind: "permission" }), "等你批准");
  assert.equal(page.waitingKind({ kind: "ask", askKind: "question" }), "等你回答");
  assert.notEqual(page.waitingKind({ kind: "ask" }), "等你回答", "legacy generic label remains unchanged");
  const thread = { runs: "machine", status: "needs_you", asks: [{ kind: "permission" }] };
  assert.equal(label(thread), "等你批准");
  assert.equal(label({ ...thread, asks: [{ kind: "question" }] }), "等你回答");
  assert.equal(label({ ...thread, asks: [{}] }), "");
  assert.equal(label({ ...thread, status: "done" }), "");
});
