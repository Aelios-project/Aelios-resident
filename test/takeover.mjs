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
let take, cloud;
try {
  await build({ entryPoints: ["src/takeover.ts", "src/cloud-tasks.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  take = await import(pathToFileURL(join(dir, "takeover.mjs")).href);
  cloud = await import(pathToFileURL(join(dir, "cloud-tasks.mjs")).href);
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
  const found = take.unfinishedWithTitle(tasks, " fix LOGIN ");
  assert.equal(found.id, old.id);
  const job = take.carryOver("check the environment", found, tasks);
  assert.ok(job.startsWith("check the environment"));
  assert.ok(job.includes("fix the login bug") && job.includes("Stopped half way."), "the old task and its last words travel along");
  const { task: fresh } = tasks.add({ title: "Fix login", job, execution: "machine" });
  take.markTakenOver(tasks, found, fresh.root);
  assert.match(tasks.get(old.id).summary, new RegExp(`^Taken over by thread ${fresh.root}\\. Stopped`));
  assert.equal(tasks.get(old.id).status, "stopped");
  assert.equal(take.unfinishedWithTitle(tasks, "Fix login"), null, "taken over once; the new thread is working");
});

await test("done, working, other titles and other places are left alone", () => {
  const tasks = store();
  unfinished(tasks, "done");
  tasks.add({ title: "Fix login", job: "x", execution: "machine" }); // sent: still working
  unfinished(tasks, "failed", { title: "Other" });
  unfinished(tasks, "failed", { execution: "local" });
  assert.equal(take.unfinishedWithTitle(tasks, "Fix login"), null);
});
