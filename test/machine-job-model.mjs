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

await test("role cards gain a machine model and family of their own, empty on old cards, kept by older pages", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE res_task_roles (name TEXT PRIMARY KEY, template TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL)");
  db.exec("INSERT INTO res_task_roles VALUES ('custom', 'Synthetic instructions', 'anthropic/claude-sonnet-5.5', 1)");
  const f = fixture(db);
  const old = f.packs.get("custom");
  assert.deepEqual([old.machineModel, old.family], [undefined, undefined], "an old card gets no machine model or family");
  assert.equal(f.packs.get("coder"), null, "migration does not recreate removed defaults");
  f.packs.save({ name: "custom", template: "Synthetic instructions", model: "anthropic/claude-sonnet-5.5", machineModel: " claude-sonnet-4-6 ", family: "anthropic" });
  const saved = new roles.RoleStore(f.sql).get("custom");
  assert.deepEqual([saved.model, saved.machineModel, saved.family], ["anthropic/claude-sonnet-5.5", "claude-sonnet-4-6", "anthropic"], "the threads' model and the machine model are kept apart");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "anthropic/claude-opus-5.5" });
  assert.deepEqual([f.packs.get("custom").machineModel, f.packs.get("custom").family], ["claude-sonnet-4-6", "anthropic"], "a page from before the machine fields keeps both");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "anthropic/claude-opus-5.5", machineModel: "gpt-5.5-codex" });
  assert.equal(f.packs.get("custom").family, undefined, "a family is not carried onto a different machine model");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "", machineModel: "", family: "" });
  assert.deepEqual([f.packs.get("custom").machineModel, f.packs.get("custom").family], [undefined, undefined]);
  for (const family of [null, 3, "two words", "Anthropic", "x".repeat(41)]) assert.ok(f.packs.save({ name: "custom", template: "x", model: "", machineModel: "m", family }).error, String(family));
  assert.ok(f.packs.save({ name: "custom", template: "x", model: "", machineModel: "two words" }).error);
});

await test("cards with saved family metadata keep it when older clients omit the machine fields", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE res_task_roles (name TEXT PRIMARY KEY, template TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, family TEXT NOT NULL DEFAULT '')");
  db.exec("INSERT INTO res_task_roles VALUES ('custom', 'Synthetic instructions', 'gateway/model', 1, 'anthropic')");
  const f = fixture(db);
  assert.equal(f.packs.get("custom").machineModel, undefined, "migration never copies the cloud model into the machine field");
  assert.equal(f.packs.get("custom").family, "anthropic");
  f.packs.save({ name: "custom", template: "Edited instructions", model: "gateway/other" });
  assert.equal(f.packs.get("custom").family, "anthropic", "omitted fields are preserved even before a machine model is set");
});

await test("machine work asks for the card's machine model and family only, never the threads' gateway model, frozen through poll replay", async () => {
  const f = fixture();
  const { token } = await f.store.register({ label: "Synthetic machine" }, true);
  const heartbeat = await f.store.heartbeat(token);
  assert.ok(heartbeat.accepts.includes("job.model") && heartbeat.accepts.includes("ask.kind"));
  const selected = f.packs.save({ name: "coder", template: "Synthetic work", model: "openai/gpt-5.5", machineModel: "gpt-5.5-codex", family: "openai" });
  const add = (role, kind = "job", follows) => {
    const { task } = f.tasks.add({ title: "Synthetic job", job: "Synthetic work", execution: "machine", role: role?.name ?? "", follows });
    f.store.enqueue(task, kind, task.job, [], role);
    return task;
  };
  const chosen = add(selected);
  f.packs.save({ name: "coder", template: "Later edit", model: "", machineModel: "other-model", family: "anthropic" });
  const first = await f.store.poll(token, { claimKey: "model_claim_1" });
  assert.equal(first.work.model, "gpt-5.5-codex");
  assert.equal(first.work.family, "openai");
  assert.deepEqual(await f.store.poll(token, { claimKey: "model_claim_1" }), first);
  assert.equal(f.store.models.forThread(chosen.root), "gpt-5.5-codex");
  assert.equal(machine.machineHelper({ plugin: "dsh", engine: "acpx@0.22.0" }, f.store.models.forThread(chosen.root)), "dsh · acpx@0.22.0 · 要的模型 gpt-5.5-codex");
  assert.equal(machine.machineHelper({ plugin: "kiro", engine: "acpx@0.22.0" }, "gpt-5.5-codex"), "kiro · acpx@0.22.0", "Kiro runs on auto: no model is shown");
  const gatewayOnly = add({ name: "reviewer", model: "anthropic/claude-sonnet-5.5", family: "anthropic" });
  const second = (await f.store.poll(token, { claimKey: "model_claim_2" })).work;
  assert.ok(!("model" in second) && !("family" in second), "the threads' gateway model is never sent to a machine");
  assert.equal(f.store.models.forThread(gatewayOnly.root), "");
  add(null, "say", chosen.id);
  assert.equal(f.store.models.forThread(chosen.root), "", "an unconfigured later message must not display a stale model");
  const modelOnly = add({ name: "custom", model: "", machineModel: "literal-id" });
  await f.store.poll(token, { claimKey: "model_claim_3" });
  const fourth = (await f.store.poll(token, { claimKey: "model_claim_4" })).work;
  assert.equal(fourth.model, "literal-id");
  assert.ok(!("family" in fourth));
  assert.equal(new machine.MachineStore(f.sql, f.tasks, fn => fn()).models.forThread(modelOnly.root), "literal-id", "survives store recreation");
});
