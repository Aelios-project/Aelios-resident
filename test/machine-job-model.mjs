import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync("node_modules/.cache/job-model-");
let machine, cloud, roles;
try {
  await build({ entryPoints: ["src/machine.ts", "src/cloud-tasks.ts", "src/task-roles.ts"], outdir: dir, bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" }, logLevel: "error" });
  [machine, cloud, roles] = await Promise.all(["machine", "cloud-tasks", "task-roles"].map(name => import(pathToFileURL(resolve(dir, name + ".mjs")).href)));
} finally { rmSync(dir, { recursive: true, force: true }); }

function fixture(db = new DatabaseSync(":memory:")) {
  const sql = (strings, ...values) => { const stmt = db.prepare(strings.join("?")); return /^\s*SELECT/i.test(strings[0]) ? stmt.all(...values) : (stmt.run(...values), []); };
  const tasks = new cloud.TaskStore(sql), packs = new roles.RoleStore(sql);
  const atomic = fn => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const store = new machine.MachineStore(sql, tasks, atomic);
  return { db, sql, tasks, packs, store };
}

await test("role cards gain optional family without inventing defaults, and old clients preserve metadata", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE res_task_roles (name TEXT PRIMARY KEY, template TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL)");
  db.exec("INSERT INTO res_task_roles VALUES ('custom', 'Synthetic instructions', 'exact-model', 1)");
  const f = fixture(db);
  assert.equal(f.packs.get("custom").family, undefined);
  assert.equal(f.packs.get("coder"), null, "migration does not recreate removed defaults");
  f.packs.save({ name: "custom", template: "Synthetic instructions", model: "exact-model", family: "anthropic" });
  assert.equal(new roles.RoleStore(f.sql).get("custom").family, "anthropic");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "exact-model" });
  assert.equal(f.packs.get("custom").family, "anthropic");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "different-model" });
  assert.equal(f.packs.get("custom").family, undefined, "do not carry a family onto a different model");
  for (const family of [null, 3, "two words", "Anthropic", "openai\n", "x".repeat(41)]) assert.ok(f.packs.save({ name: "custom", template: "x", model: "x", family }).error);
});

await test("machine work carries only the role card's explicit model and family, frozen through poll replay", async () => {
  const f = fixture();
  const { token } = await f.store.register({ label: "Synthetic machine" }, true);
  const heartbeat = await f.store.heartbeat(token);
  assert.ok(heartbeat.accepts.includes("job.model"));
  const selected = f.packs.save({ name: "coder", template: "Synthetic work", model: "exact/vendor-model-v2", family: "openai" });
  const add = (role, kind = "job", follows) => {
    const { task } = f.tasks.add({ title: "Synthetic job", job: "Synthetic work", execution: "machine", role: role?.name ?? "", follows });
    f.store.enqueue(task, kind, task.job, [], role);
    return task;
  };
  const chosen = add(selected);
  f.packs.save({ name: "coder", template: "Later edit", model: "other-model", family: "anthropic" });
  const first = await f.store.poll(token, { claimKey: "model_claim_1" });
  assert.equal(first.work.model, "exact/vendor-model-v2");
  assert.equal(first.work.family, "openai");
  assert.deepEqual(await f.store.poll(token, { claimKey: "model_claim_1" }), first);
  assert.equal(f.store.models.forThread(chosen.root), "exact/vendor-model-v2");
  assert.equal(machine.machineHelper({ plugin: "dsh", engine: "acpx@0.22.0" }, f.store.models.forThread(chosen.root)), "dsh · acpx@0.22.0 · requested model: exact/vendor-model-v2");
  const noModel = add({ name: "reviewer", model: "", family: "anthropic" });
  const second = (await f.store.poll(token, { claimKey: "model_claim_2" })).work;
  assert.ok(!("model" in second) && !("family" in second));
  assert.equal(f.store.models.forThread(noModel.root), "");
  add(null, "say", chosen.id);
  assert.equal(f.store.models.forThread(chosen.root), "", "an unconfigured later message must not display a stale model");
  const modelOnly = add({ name: "custom", model: "literal-id" });
  await f.store.poll(token, { claimKey: "model_claim_3" });
  const fourth = (await f.store.poll(token, { claimKey: "model_claim_4" })).work;
  assert.equal(fourth.model, "literal-id");
  assert.ok(!("family" in fourth));
  assert.equal(new machine.MachineStore(f.sql, f.tasks, fn => fn()).models.forThread(modelOnly.root), "literal-id", "survives store recreation");
});
