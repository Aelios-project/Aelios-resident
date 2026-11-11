// One card per thread on the waiting list (src/waiting-merge.ts, src/waiting-store.ts, public/waiting-reason.js):
// a thread that holds a permission and asked a question shows one card saying why it waits, with Allow / Deny for
// the permission and the question's options; the page shows no thread row of its own for a thread with a card.
// Run: node test/waiting-merge.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "waiting-merge-"));
let merge, store, machine, cloud;
try {
  await build({ entryPoints: ["src/waiting-merge.ts", "src/waiting-store.ts", "src/machine.ts", "src/cloud-tasks.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [merge, store, machine, cloud] = await Promise.all([load("waiting-merge"), load("waiting-store"), load("machine"), load("cloud-tasks")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const now = 100 * 86_400_000;
const item = (extra = {}) => ({ id: "a:ask:k1", kind: "ask", thread: "a", task: "a-t", title: "Title a", line: "Pick one.", options: [], recommend: "", at: now - 1000, action: "", ...extra });
const perm = (extra = {}) => item({ id: "a:perm:p_0123456789", kind: "permission", perm: "p_0123456789", line: "rm -rf build", detail: "rm -rf build", at: now - 500, ...extra });

await test("one card per thread: a held permission and a question become one card that says both reasons", () => {
  const merged = merge.mergeByThread([
    item({ askKind: "question", line: "Which branch?", options: ["main", "dev"], at: now - 2000 }),
    perm()
  ]);
  assert.equal(merged.length, 1, "one card, not two");
  const card = merged[0];
  assert.equal(card.kind, "permission", "a live permission is the one with the buttons");
  assert.equal(card.perm, "p_0123456789", "its Allow / Deny handle is kept");
  assert.equal(card.task, "a-t", "the question's answer still goes to the task that asked");
  assert.deepEqual(card.options, ["main", "dev"], "the question's options are on the same card");
  assert.equal(card.line, "rm -rf build", "the live permission lends its own text");
  assert.deepEqual(card.reasons, ["permission", "question"], "a permission comes first");
  assert.equal(card.reason, undefined, "two reasons are told as a list");
});

await test("a typed approval with no handle routes its options through the task, never an Allow / Deny on no id", () => {
  const [card] = merge.mergeByThread([
    item({ id: "a:ask:k2", askKind: "question", line: "Which?", options: ["A"], at: now - 2000 }),
    item({ id: "a:ask:k1", askKind: "permission", task: "approval-task", line: "Run the tests?", options: [], at: now - 3000 })
  ]);
  assert.equal(card.perm, undefined, "there is no live request to answer");
  assert.deepEqual(card.reasons, ["permission", "question"]);
  assert.deepEqual(card.options, ["Allow", "Deny"], "approval buttons remain available without a live handle");
  assert.equal(card.task, "approval-task", "the decision goes to the approval task");
});

await test("the newest live permission wins, keeping its own title and detail; a stray question line does not displace it", () => {
  const [card] = merge.mergeByThread([
    perm({ id: "a:perm:p_old0000000", perm: "p_old0000000", line: "cp a b", detail: "cp a b", at: now - 4000 }),
    perm({ at: now - 1000 }),
    item({ askKind: "question", line: "Also, which branch?", options: ["x"], at: now - 100, title: "Title a" })
  ]);
  assert.equal(card.line, "rm -rf build", "the newest live permission's text, not the older one or the question's");
  assert.equal(card.detail, "rm -rf build");
  assert.equal(card.perm, "p_0123456789", "the newest one");
  assert.equal(card.at, now - 100, "the card is as new as the newest thing on it");
});

await test("a lone item is unchanged; a lone live permission reads as approval; an untyped ask keeps the old wording", () => {
  const [alone] = merge.mergeByThread([perm()]);
  assert.equal(alone.id, "a:perm:p_0123456789", "not folded with anything");
  assert.equal(alone.reason, undefined, "a live permission is labelled by its kind");
  const [ask] = merge.mergeByThread([item()]);
  assert.equal(ask.reason, "ask", "no kind reported: the generic reason");
  assert.deepEqual(merge.mergeByThread([item({ askKind: "question" })]).map((i) => i.reason), ["question"]);
  assert.equal(merge.askReason(undefined), "ask");
});

await test("a stuck failure and an ask on one thread are one card too", () => {
  const merged = merge.mergeByThread([
    item({ id: "a:stuck:5", kind: "stuck", action: "open", line: "It failed." }),
    item({ id: "a:ask:k1", askKind: "question", line: "Which?", options: ["x"], at: now - 100 })
  ]);
  assert.equal(merged.length, 1, "the page shows the thread once");
  assert.equal(merged[0].thread, "a");
  assert.equal(merged[0].options.length, 1);
});

await test("the real page filters duplicate open and completed thread rows", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync("public/waiting.js", "utf8"), context);
  const page = vm.runInContext("waitingPage()", context);
  page.waitList.items = [{ thread: "waiting" }];
  page.threadsIn = () => [{ id: "waiting" }, { id: "other" }];
  for (const group of ["open", "done"]) {
    assert.deepEqual(Array.from(page.waitingThreads(group), (row) => row.id), ["other"]);
  }
  const html = readFileSync("public/index.html", "utf8");
  assert.ok(html.includes('x-for="item in waitingThreads(\'open\')"'));
  assert.ok(html.includes('x-for="item in waitingThreads(\'done\')"'));
  assert.ok(!html.includes('x-for="item in threadsIn('), "both thread lists use the filtered page data");
});

await test("an old tier refusal in a stored line is shown as today's approval wording, and nothing else is rewritten", () => {
  const legacy = "The helper wanted to do the following, but this machine's tier is read, so it was refused.";
  assert.equal(merge.currentWording(legacy), "The helper needs your approval for the following operation.");
  assert.ok(!/tier is read/i.test(merge.currentWording(legacy)), "the obsolete phrase is gone");
  assert.match(merge.currentWording(legacy), /needs your approval/);
  assert.equal(merge.currentWording("The helper wanted to run rm -rf build."), "The helper wanted to run rm -rf build.", "other text untouched");
  const [card] = merge.mergeByThread([item({ line: legacy })]);
  assert.ok(!/tier is read/i.test(card.line), "the card shows the current wording");
});

const REASONS = readFileSync(new URL("../public/waiting-reason.js", import.meta.url), "utf8");
await test("the labels: approval, answer and the generic wait; a card with two reasons shows both", () => {
  const page = vm.createContext({ machineAskKindLabel: (kind) => (kind === "permission" ? "\u7b49\u4f60\u6279\u51c6" : kind === "question" ? "\u7b49\u4f60\u56de\u7b54" : "") });
  vm.runInContext(REASONS, page);
  vm.runInContext(readFileSync(new URL("../public/waiting.js", import.meta.url), "utf8"), page);
  const kind = (entry) => vm.runInContext(`waitingPage().waitingKind(${JSON.stringify(entry)})`, page);
  const label = (reason) => vm.runInContext(`waitingReasonLabel(${JSON.stringify(reason)})`, page);
  assert.equal(label("permission"), "\u7b49\u4f60\u6279\u51c6");
  assert.equal(label("question"), "\u7b49\u4f60\u56de\u7b54");
  assert.equal(label("ask"), "\u7b49\u4f60");
  assert.equal(kind({ kind: "ask", askKind: "question" }), "\u7b49\u4f60\u56de\u7b54", "a lone question is as before");
  assert.equal(kind({ kind: "permission" }), "\u7b49\u4f60\u6279\u51c6", "a lone live permission reads as approval");
  assert.equal(kind({ kind: "stuck" }), "\u5361\u4f4f\u4e86");
  assert.equal(kind({ kind: "permission", reasons: ["permission", "question"] }), "\u7b49\u4f60\u6279\u51c6 \u00b7 \u7b49\u4f60\u56de\u7b54");
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  const atomic = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const tasks = new cloud.TaskStore(sql);
  const machines = new machine.MachineStore(sql, tasks, atomic);
  return { tasks, machines, list: new store.WaitingStore(sql, tasks, machines) };
}

await test("the store lists one card for a thread that holds a permission and asked a question at once", async () => {
  const f = fixture();
  const { code } = await f.machines.code();
  const { token } = await f.machines.register({ label: "VPS", code }, false);
  await f.machines.heartbeat(token);
  const { task } = f.tasks.add({ title: "Job", job: "do it", execution: "machine" });
  f.machines.enqueue(task, "job", "do it");
  const { work } = await f.machines.poll(token, { claimKey: "ck_dddddddd" });
  await f.machines.receipt(token, { receiptId: `${work.workId}:final`, workId: work.workId, token: work.token, type: "final", status: "needs_you", summary: "Waiting.",
    ask: { key: "q1", question: "Which one?", options: ["A"], kind: "question" } });
  f.machines.perms.held({ work_id: work.workId, thread: task.id, task_id: task.id }, { id: "p_aaaaaaaaaa", title: "rm -rf build", kind: "other", detail: "rm -rf build" });
  const { items, open } = f.list.list();
  assert.equal(items.length, 1, "one card, both ways of waiting");
  assert.equal(open, 1);
  const [card] = items;
  assert.equal(card.thread, task.id);
  assert.equal(card.perm, "p_aaaaaaaaaa", "Allow / Deny still answers the held permission");
  assert.deepEqual(card.options, ["A"], "the question is answered from the same card");
  assert.deepEqual(card.reasons, ["permission", "question"]);
  // Answering the permission leaves the question on its own card.
  assert.equal(f.list.decide("p_aaaaaaaaaa", true), true);
  const after = f.list.list().items;
  assert.equal(after.length, 1);
  assert.equal(after[0].perm, undefined, "the permission is gone");
  assert.deepEqual(after[0].options, ["A"], "the question is still there");
  assert.equal(after[0].reason, "question");
});

await test("every held permission pushes once by its own id: a second request in one thread still pushes", async () => {
  const f = fixture();
  const { code } = await f.machines.code();
  const { token } = await f.machines.register({ label: "VPS", code }, false);
  await f.machines.heartbeat(token);
  const { task } = f.tasks.add({ title: "Job", job: "do it", execution: "machine" });
  f.machines.enqueue(task, "job", "do it");
  const { work } = await f.machines.poll(token, { claimKey: "ck_eeeeeeee" });
  const held = (id) => f.machines.perms.held({ work_id: work.workId, thread: task.id, task_id: task.id }, { id, title: `cmd ${id}`, kind: "other", detail: `cmd ${id}` });
  held("p_1111111111");
  assert.equal(f.list.unpushed().length, 1, "the first is pushed");
  assert.equal(f.list.unpushed().length, 0, "and only once");
  held("p_2222222222");
  assert.equal(f.list.unpushed().length, 1, "a second held request in the same thread pushes too");
  assert.equal(f.list.list().items.length, 1, "while the page still shows one card");
});