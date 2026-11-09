// A new thread with the title of an unfinished machine thread takes its work over (src/takeover.ts).
// Run: node test/takeover.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "takeover-"));
let take, cloud, machine;
try {
  await build({ entryPoints: ["src/takeover.ts", "src/cloud-tasks.ts", "src/machine.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  take = await import(pathToFileURL(join(dir, "takeover.mjs")).href);
  cloud = await import(pathToFileURL(join(dir, "cloud-tasks.mjs")).href);
  machine = await import(pathToFileURL(join(dir, "machine.mjs")).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  return new cloud.TaskStore(sql);
}
const unfinished = (tasks, status, extra = {}) => {
  const { task } = tasks.add({ title: "Fix login", job: "fix the login bug", execution: "machine", ...extra });
  tasks.result(task.id, { status, summary: "Stopped half way.", links: [] });
  return tasks.get(task.id);
};

await test("an unfinished thread with the same title is found, carried over, and marked once", () => {
  const tasks = store();
  const old = unfinished(tasks, "failed");
  const found = take.unfinishedWithTitle(tasks, " fix LOGIN ", () => false);
  assert.equal(found.id, old.id);
  const job = take.carryOver("check the environment", found, tasks);
  assert.ok(job.startsWith("check the environment"));
  assert.ok(job.includes("fix the login bug") && job.includes("Stopped half way."), "the old task and its last words travel along");
  const { task: fresh } = tasks.add({ title: "Fix login", job, execution: "machine" });
  take.markTakenOver(tasks, found, fresh.root);
  assert.match(tasks.get(old.id).summary, new RegExp(`^Taken over by thread ${fresh.root}\\. Stopped`));
  assert.equal(tasks.get(old.id).status, "stopped");
  assert.equal(take.unfinishedWithTitle(tasks, "Fix login", () => false), null, "taken over once; the new thread is working");
});

await test("claimed quiet work and expired work cannot be taken over before a final receipt", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  const atomic = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const tasks = new cloud.TaskStore(sql);
  const machines = new machine.MachineStore(sql, tasks, atomic);
  const { token } = await machines.register({ label: "test" }, true);
  await machines.heartbeat(token);
  const { task: old } = tasks.add({ title: "Fix login", job: "old job", execution: "machine" });
  machines.enqueue(old, "job", old.job);
  assert.equal(take.unfinishedWithTitle(tasks, old.title, (root) => machines.unsettled(root)), null);
  const { work } = await machines.poll(token, { claimKey: "ck_12345678" });
  tasks.moved(old.id, "quiet", "No recent progress");
  assert.equal(take.unfinishedWithTitle(tasks, old.title, (root) => machines.unsettled(root)), null);
  db.prepare("UPDATE res_machine_work SET lease_until = 0 WHERE work_id = ?").run(work.workId);
  machines.expire();
  assert.equal(tasks.get(old.id).status, "failed");
  assert.equal(take.unfinishedWithTitle(tasks, old.title, (root) => machines.unsettled(root)), null, "a lapsed lease still allows a late final");
  db.prepare("UPDATE res_machine_work SET created_at = 0 WHERE work_id = ?").run(work.workId);
  const { task: other } = tasks.add({ title: "Other", job: "other job", execution: "machine" });
  machines.enqueue(other, "job", other.job);
  assert.equal(db.prepare("SELECT count(*) AS n FROM res_machine_work WHERE work_id = ?").get(work.workId).n, 1, "cleanup retains unresolved work");
  db.prepare("UPDATE res_machine_work SET created_at = ? WHERE work_id = ?").run(Date.now(), work.workId);
  await machines.receipt(token, { receiptId: `${work.workId}:final`, workId: work.workId, token: work.token, type: "final", status: "failed", summary: "Stopped halfway" });
  const found = take.unfinishedWithTitle(tasks, old.title, (root) => machines.unsettled(root));
  assert.equal(found.id, old.id);
  assert.equal(take.stillTakeable(tasks, found, (root) => machines.unsettled(root)), true);
  const { task: followup } = tasks.add({ title: old.title, job: "followup", execution: "machine", follows: old.id });
  machines.enqueue(followup, "mail", followup.job);
  assert.equal(take.stillTakeable(tasks, found, (root) => machines.unsettled(root)), false, "new work during dispatch prevents marking the old task");
  tasks.drop(followup.id);
  db.prepare("DELETE FROM res_machine_work WHERE task_id = ?").run(followup.id);
  const { task: fresh } = tasks.add({ title: old.title, job: "new job", execution: "machine" });
  machines.enqueue(fresh, "job", fresh.job);
  take.markTakenOver(tasks, found, fresh.root);
  await machines.receipt(token, { receiptId: `${work.workId}:final`, workId: work.workId, token: work.token, type: "final", status: "failed", summary: "Stopped halfway" });
  assert.match(tasks.get(old.id).summary, /^Taken over by thread /, "a replay cannot replace the marker");
  db.prepare("DELETE FROM res_machine_work WHERE work_id = ?").run(work.workId);
  assert.equal(machines.unsettled(old.root), true, "a task with missing historical work is not assumed safe");
});

await test("done, working, other titles and other places are left alone", () => {
  const tasks = store();
  unfinished(tasks, "done");
  tasks.add({ title: "Fix login", job: "x", execution: "machine" }); // sent: still working
  unfinished(tasks, "failed", { title: "Other" });
  unfinished(tasks, "failed", { execution: "local" });
  assert.equal(take.unfinishedWithTitle(tasks, "Fix login", () => false), null);
});
