// The waiting list (src/waiting.ts, src/waiting-store.ts): kinds, order, one item per id, resolved asks leave, expiry,
// stopped threads give nothing, notes and pushes. Run: node test/waiting.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "waiting-"));
let waiting, store, machine, cloud;
try {
  await build({ entryPoints: ["src/waiting.ts", "src/waiting-store.ts", "src/machine.ts", "src/cloud-tasks.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [waiting, store, machine, cloud] = await Promise.all([load("waiting"), load("waiting-store"), load("machine"), load("cloud-tasks")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const DAY = 86_400_000;
const now = 100 * DAY;
const thread = (id, extra = {}) => ({ id, taskId: `${id}-t`, title: `Title ${id}`, status: "working", runs: "machine", summary: "", choices: [], reason: "", waiting: false, updatedAt: now - 1000, ...extra });
const input = (extra = {}) => ({ asks: [], notes: [], threads: [], seen: new Set(), now, ...extra });
const ask = (extra = {}) => ({ thread: "a", task: "a-t", key: "k1", question: "Which one first? Then more.", options: ["A", "B"], recommend: "A", at: now - 1000, ...extra });

await test("only decisions and actions are listed: asks first, a stuck one with an action; done and note are news", () => {
  const { items, news } = waiting.build(input({
    asks: [ask()],
    notes: [{ thread: "b", task: "b-t", key: "w1", text: "Found two config files. Using the first.", at: now - 500 }],
    threads: [thread("a", { status: "needs_you" }), thread("b"), thread("c", { status: "done", summary: "All done. Details follow." }),
      thread("d", { status: "failed", summary: "Blocked: no network" }), thread("e", { status: "failed", summary: "The API key was rejected." }),
      thread("f", { status: "failed", summary: "Failed", choices: ["Retry"] })]
  }));
  assert.deepEqual(items.map((i) => [i.thread, i.kind, i.action]), [["a", "ask", ""], ["e", "stuck", "settings"]].sort((x, y) => items.findIndex((i) => i.thread === x[0]) - items.findIndex((i) => i.thread === y[0])));
  assert.deepEqual(items[0], { id: "a:ask:k1", kind: "ask", thread: "a", task: "a-t", title: "Title a", line: "Which one first?", options: ["A", "B"], recommend: "A", at: now - 1000, action: "" });
  assert.deepEqual(news.map((i) => [i.thread, i.kind]).sort(), [["b", "note"], ["c", "done"]]);
  assert.equal(waiting.firstSentence("x".repeat(300)).length, 120);
  assert.equal(waiting.stuckAction("Blocked: no network"), null);
  assert.equal(waiting.stuckAction("Permission denied for rm"), "open");
});

await test("the runner's reason code decides what a failure asks of the owner; the keywords are only the fallback", () => {
  assert.equal(waiting.stuckAction("anything", "needs_login"), "settings");
  assert.equal(waiting.stuckAction("anything", "missing_key"), "settings");
  assert.equal(waiting.stuckAction("anything", "permission_denied"), "open");
  for (const reason of ["helper_missing", "workspace_denied", "error"]) assert.equal(waiting.stuckAction("The API key was rejected.", reason), null, "a code that is not actionable wins over the words");
  assert.equal(waiting.stuckAction("The API key was rejected.", ""), "settings", "old rows: keywords");
  const { items } = waiting.build(input({ threads: [thread("a", { status: "failed", summary: "x", reason: "needs_login" }), thread("b", { status: "failed", summary: "x", reason: "error" })] }));
  assert.deepEqual(items.map((i) => [i.thread, i.action]), [["a", "settings"]]);
});

await test("the keyword fallback wants a setting only when the words say so: not a bare 'token' or 'log in'", () => {
  for (const said of ["The API key was rejected.", "GitHub token is missing", "invalid token", "Access token expired", "Please log in to continue", "Not logged in.",
    "401 Unauthorized", "authentication failed", "no credentials found", "需要先登录"]) assert.equal(waiting.stuckAction(said), "settings", said);
  for (const said of ["SyntaxError: Unexpected token } in JSON at position 4", "Token limit exceeded for this model", "Wrote the log in /tmp/out.txt",
    "Blocked: no network from this machine"]) assert.equal(waiting.stuckAction(said), null, said);
});

await test("a stuck item put aside leaves the list; the thread failing again brings a new one", () => {
  const failed = (at) => thread("a", { status: "failed", summary: "x", reason: "needs_login", updatedAt: at });
  const first = waiting.build(input({ threads: [failed(now - 1000)] })).items;
  assert.deepEqual(first.map((i) => i.kind), ["stuck"]);
  assert.deepEqual(waiting.build(input({ threads: [failed(now - 1000)], seen: new Set([first[0].id]) })).items, [], "put aside");
  assert.equal(waiting.build(input({ threads: [failed(now - 10)], seen: new Set([first[0].id]) })).items.length, 1, "a new failure is a new item");
});

await test("a needs_you thread without a question is not an ask; a machine thread's needs_you shows only its ask; a stopped one gives nothing", () => {
  const items = waiting.build(input({ threads: [thread("c", { runs: "linux", status: "needs_you", waiting: true, summary: "Pick one.", choices: ["X"] }),
    thread("n", { runs: "linux", status: "needs_you", waiting: true, summary: "" }), thread("s", { status: "stopped" }), thread("m", { status: "needs_you", waiting: true })] })).items;
  assert.deepEqual(items.map((i) => [i.thread, i.kind, i.options]), [["c", "ask", ["X"]]]);
});

await test("the same ask twice is one item; read news goes; a newer note replaces the older; an ask older than 7 days leaves", () => {
  const twice = waiting.build(input({ asks: [ask({ at: now - 2000 }), ask({ at: now - 1000, question: "Newer?" })], threads: [thread("a")] })).items;
  assert.deepEqual(twice.map((i) => i.line), ["Newer?"]);
  const notes = [{ thread: "a", task: "a-t", key: "w1", text: "old", at: now - 3000 }, { thread: "a", task: "a-t", key: "w2", text: "new", at: now - 1000 }];
  assert.deepEqual(waiting.build(input({ notes, threads: [thread("a")] })).news.map((i) => i.line), ["new"]);
  assert.deepEqual(waiting.build(input({ notes, threads: [thread("a")], seen: new Set(["a:note:w2"]) })).news, []);
  assert.deepEqual(waiting.build(input({ asks: [ask({ at: now - 8 * DAY })], threads: [thread("a")] })).items, []);
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

await test("the store: an ask from a receipt is listed and pushed once; resolving it removes it; a done is read once", async () => {
  const f = fixture();
  const { code } = await f.machines.code();
  const { token } = await f.machines.register({ label: "VPS", code }, false);
  await f.machines.heartbeat(token);
  const { task } = f.tasks.add({ title: "Job", job: "do it", execution: "machine" });
  f.machines.enqueue(task, "job", "do it");
  const { work } = await f.machines.poll(token, { claimKey: "ck_aaaaaaaa" });
  const receipt = (extra) => ({ receiptId: `${work.workId}:final`, workId: work.workId, token: work.token, type: "final", ...extra });
  await f.machines.receipt(token, receipt({ status: "needs_you", summary: "Waiting.", ask: { key: "q1", question: "Which?", options: ["A"] } }));
  let { items, open, unread } = f.list.list();
  assert.deepEqual([items.map((i) => i.kind), open, unread], [["ask"], 1, {}]);
  assert.equal(f.list.unpushed().length, 1);
  assert.equal(f.list.unpushed().length, 0, "once per item");
  // A later job in the thread finishes and resolves the ask: the ask goes, the done shows.
  const { task: next } = f.tasks.add({ title: "Job", job: "go on", execution: "machine", follows: task.id, direct: true });
  f.machines.enqueue(next, "say", "go on");
  const { work: second } = await f.machines.poll(token, { claimKey: "ck_bbbbbbbb" });
  await f.machines.receipt(token, { receiptId: `${second.workId}:final`, workId: second.workId, token: second.token, type: "final", status: "done", summary: "Done. Fine.", resolve: ["q1"] });
  ({ items, open, unread } = f.list.list());
  assert.deepEqual([items, open, Object.values(unread)], [[], 0, [1]], "a done is not on the list, only unread on its thread");
  assert.equal(f.list.unpushed().length, 0, "a done is not pushed");
  f.list.read(task.id);
  assert.deepEqual(f.list.list().unread, {}, "opening the thread reads its news");
});

await test("the store: a stuck item can be put aside, an ask cannot be put aside this way", async () => {
  const f = fixture();
  const { code } = await f.machines.code();
  const { token } = await f.machines.register({ label: "VPS", code }, false);
  await f.machines.heartbeat(token);
  const { task } = f.tasks.add({ title: "Job", job: "do it", execution: "machine" });
  f.machines.enqueue(task, "job", "do it");
  const { work } = await f.machines.poll(token, { claimKey: "ck_cccccccc" });
  await f.machines.receipt(token, { receiptId: `${work.workId}:final`, workId: work.workId, token: work.token, type: "final", status: "failed", summary: "Not signed in.", reason: "needs_login" });
  const [stuck] = f.list.list().items;
  assert.equal(stuck.kind, "stuck");
  f.list.dismiss("nothing:like:this");
  assert.equal(f.list.list().items.length, 1, "an unknown id changes nothing");
  f.list.dismiss(stuck.id);
  assert.deepEqual(f.list.list().items, []);
});
