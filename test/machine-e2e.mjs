// End to end: the local Worker, the real runner (Aelios-desktop, packages/runner) and its pretend ACP helper (test/fake-agent.mjs).
// A job the resident sends goes to the machine and its words come back to the thread; her words to a running thread
// stop the turn and go into the same session; an ASK: line makes the thread wait for her, and her answer resolves it.
// A turn that ends done or failed makes the resident tell them once (one she answered in the thread herself it may pass
// on); a stopped or waiting one only leaves a record (a note).
// Needs the Worker and the mock server, like test/run.mjs (a fresh Worker: delete .wrangler/state first):
//   node test/mock-server.mjs & NO_PROXY=127.0.0.1 npx wrangler dev --config wrangler.test.jsonc --port 8787 &
//   NO_PROXY=127.0.0.1 node test/machine-e2e.mjs
// The runner is fetched at RUNNER_COMMIT from Aelios-desktop. To use a local copy: RUNNER_DIR=/path/to/Aelios-desktop/packages/runner.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKER = "http://127.0.0.1:8787";
const KEY = "test-web-key";
const RUNNER_REPO = "https://github.com/Aelios-project/Aelios-desktop.git";
// Pinned to the runner that sends progress steps (PROTOCOL.md, progress), on Aelios-desktop main. A normal merge keeps this commit in main's history, so the pin stays valid.
const RUNNER_COMMIT = "9e2c009dc9f834d9ac4ca18073aacb46fd4bf470";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const web = async (route, body) => {
  const response = await fetch(`${WORKER}${route}`, { method: body ? "POST" : "GET", headers: { "x-web-key": KEY, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
};
async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
let failed = false;
async function step(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed = true; console.log(`FAIL ${name}: ${error.stack}`); }
}

const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "machine-e2e-")));
let runnerDir = process.env.RUNNER_DIR && path.resolve(process.env.RUNNER_DIR);
if (!runnerDir) {
  const repo = path.join(home, "desktop");
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  mkdirSync(repo);
  git("init", "-q");
  git("fetch", "-q", "--depth", "1", RUNNER_REPO, RUNNER_COMMIT);
  git("checkout", "-q", "FETCH_HEAD");
  runnerDir = path.join(repo, "packages", "runner");
}
const RUNNER = path.join(runnerDir, "bin", "aelios-runner.mjs");
const AGENT = path.join(runnerDir, "test", "fake-agent.mjs");
const store = path.join(home, "agent.json");
writeFileSync(store, JSON.stringify({ sessions: {}, log: [], n: 0 }));
const env = { ...process.env, AELIOS_RUNNER_HOME: path.join(home, "runner"), FAKE_STORE: store };
const prompts = () => JSON.parse(readFileSync(store, "utf8")).log.filter((e) => e.event === "prompt");
const assistantLines = async () => (await web("/web/messages")).data.data.filter((line) => line.role === "assistant").length;
const threadOf = async (id) => (await web(`/web/thread?id=${id}`)).data;
/** Sent from the web page; the newest machine thread afterwards. */
async function send(text) {
  const before = new Set((await web("/web/threads")).data.threads.map((t) => t.id));
  assert.equal((await web("/web/say", { text })).status, 200);
  return until(async () => (await web("/web/threads")).data.threads.find((t) => t.runs === "machine" && !before.has(t.id)), "a new machine thread");
}
/** The resident's replies stop coming (a finished job makes it speak once). */
async function settled() {
  let last = -1;
  for (;;) { const now = await assistantLines(); if (now === last) return; last = now; await sleep(1500); }
}
let runner;
/** The thread sent while the slow turn runs, which the permission step answers. */
let held;

try {
  await step("turned on and paired with a one-time code from the settings page; offline until the runner starts", async () => {
    assert.equal((await web("/web/config", { key: "CLOUD_TASKS", text: "on" })).status, 200);
    assert.equal((await web("/web/runner")).data.machine, null);
    const { data } = await web("/web/runner/code", {});
    assert.match(data.code, /^pc_[0-9a-f]{20}$/);
    execFileSync(process.execPath, [RUNNER, "pair", "--code", data.code, "--url", WORKER, "--workspace", path.join(home, "work"), "--access", "edit", "--plugin", "command", "--command", JSON.stringify([AGENT, "acp"])], { env });
    const config = path.join(home, "runner", "config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), pollMs: 200, heartbeatMs: 500 }));
    const shown = (await web("/web/runner")).data.machine;
    assert.equal(shown.online, false);
    // Offline: the resident is told at once, nothing waits in a queue.
    assert.equal((await web("/web/say", { text: "机器派活 不该排队" })).status, 200);
    const said = (await web("/web/messages")).data.data.filter((line) => line.role === "assistant").at(-1).text;
    assert.match(said, /不在线/);
    assert.ok(!(await web("/web/threads")).data.threads.some((t) => t.runs === "machine"));
    runner = spawn(process.execPath, [RUNNER, "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
    await until(async () => (await web("/web/runner")).data.machine?.online, "the machine online");
    // Its heartbeat says which helper it drives (a runner that names its engine shows that too).
    assert.equal((await web("/web/runner")).data.machine.plugin, "command");
  });

  let first;
  await step("a job the resident sends runs on the machine; the thread shows its own words; the resident tells them once", async () => {
    first = await send("机器派活 做完它");
    const replies = await assistantLines();
    const done = await until(async () => { const t = await threadOf(first.id); return t.status === "done" && t; }, "done");
    const reply = done.lines.find((line) => line.role === "result");
    assert.match(reply.text, /done: 做完它/);
    assert.equal(prompts()[0].text, "做完它", "only the job goes to the helper");
    await until(async () => (await assistantLines()) === replies + 1, "the resident to tell them");
    await sleep(1500);
    assert.equal(await assistantLines(), replies + 1, "told once, not again");
    assert.match((await web("/web/messages")).data.data.filter((line) => line.role === "assistant").at(-1).text, /云端回来了.*做完它/s);
  });

  await step("her words to a running thread stop the turn and go into the same session; the reply is the thread's own", async () => {
    const t = await send("机器派活 SLOW 长活");
    await until(async () => (await threadOf(t.id)).status === "working", "working");
    await until(() => prompts().some((p) => p.text === "SLOW 长活"), "the slow turn started");
    const said = await web("/web/thread/say", { id: t.id, text: "换个做法" });
    assert.equal(said.status, 200, JSON.stringify(said.data));
    const thread = await until(async () => { const v = await threadOf(t.id); return v.status === "done" && v.tasks.length === 2 && v; }, "her words answered");
    assert.deepEqual(thread.tasks.map((task) => task.status), ["stopped", "done"], "the interrupted turn, then hers");
    assert.match(thread.lines.at(-1).text, /done: 换个做法/);
    const [slow, hers] = prompts().slice(-2);
    assert.equal(slow.sessionId, hers.sessionId, "the same session");
    assert.ok(JSON.parse(readFileSync(store, "utf8")).log.some((e) => e.event === "session/cancel"));
    // What the thread answered her wakes the resident too: here it has something to say about it.
    await settled();
    const replies = await assistantLines();
    assert.equal((await web("/web/thread/say", { id: t.id, text: "告诉住户" })).status, 200);
    await until(async () => (await assistantLines()) === replies + 1, "the resident to hear of it");
    assert.match((await web("/web/messages")).data.data.filter((line) => line.role === "assistant").at(-1).text, /云端回来了.*done: 告诉住户/s);
  });

  await step("a file sent into a thread shows as its name in her line, never its content, and is refused without a name or bytes", async () => {
    const data = Buffer.from("secret body").toString("base64");
    const own = await send("机器派活 带文件");
    await until(async () => (await threadOf(own.id)).status === "done", "done");
    const said = await web("/web/thread/say", { id: own.id, text: "看这个", files: [{ name: "notes.txt", data }] });
    assert.equal(said.status, 200, JSON.stringify(said.data));
    const line = said.data.lines.findLast((l) => l.role === "user");
    assert.equal(line.text, "看这个\n\n[attached: notes.txt]");
    assert.ok(!JSON.stringify(said.data).includes("secret body"));
    assert.equal((await web("/web/thread/say", { id: own.id, text: "x", files: [{ name: "a.txt", data: "" }] })).status, 400);
    await until(async () => (await threadOf(own.id)).status === "done", "done again");
  });

  await step("an ASK: line makes the thread wait for her with its question kept; her answer resolves it", async () => {
    const t = await send("机器派活 ASKME 选哪个");
    const asked = await until(async () => { const v = await threadOf(t.id); return v.status === "needs_you" && v; }, "needs_you");
    assert.equal(asked.tasks.at(-1).waiting, true);
    assert.equal(asked.asks.length, 1);
    assert.equal(asked.asks[0].question, "Which one first?");
    assert.ok((await web("/web/threads")).data.threads.find((x) => x.id === t.id).waiting);
    assert.equal((await web("/web/thread/say", { id: t.id, text: "先做 A" })).status, 200);
    const answered = await until(async () => { const v = await threadOf(t.id); return v.status === "done" && v; }, "answered");
    assert.deepEqual(answered.asks, [], "resolved");
    assert.equal((await web("/web/threads")).data.threads.find((x) => x.id === t.id).waiting, false);
  });

  await step("the resident's own follow-up is mailed to the same session", async () => {
    assert.equal((await web("/web/say", { text: `机器接着派 ${first.id} 再看一遍` })).status, 200);
    const thread = await until(async () => { const v = await threadOf(first.id); return v.tasks.length === 2 && v.status === "done" && v; }, "follow-up done");
    assert.match(thread.lines.at(-1).text, /done: 再看一遍/);
    const sessions = prompts().filter((p) => p.text === "做完它" || p.text === "再看一遍").map((p) => p.sessionId);
    assert.equal(new Set(sessions).size, 1);
  });

  await step("the waiting list: a note, a blocked thread and an answered ask, none of it in the conversation", async () => {
    const waitingList = async () => (await web("/web/waiting")).data;
    const noted = await send("机器派活 NOTEME 看看");
    await until(async () => (await threadOf(noted.id)).status === "done", "the note job done");
    const report = (await threadOf(noted.id)).lines.find((line) => line.role === "result");
    assert.equal(report.note, "found two config files", "the note shows under the report on the thread's page");
    await settled();
    // News is not on the list: it is an unread count on the thread, and opening the thread clears it (done + note = 2).
    assert.deepEqual((await waitingList()).items.filter((i) => i.thread === noted.id), []);
    assert.equal((await waitingList()).unread[noted.id], 2);
    assert.equal((await web("/web/waiting/seen", { id: noted.id })).status, 200);
    assert.equal((await waitingList()).unread[noted.id], undefined, "opening the thread cleared its unread");
    const blocked = await send("机器派活 BLOCKME 取回来");
    await until(async () => (await threadOf(blocked.id)).status === "failed", "the blocked job");
    await settled();
    assert.ok(!(await waitingList()).items.some((i) => i.thread === blocked.id), "a failure the owner can do nothing about is only the thread's status");
    const asked = await send("机器派活 ASKME 再选");
    await until(async () => (await waitingList()).items.some((i) => i.thread === asked.id && i.kind === "ask"), "the ask in the list");
    const listed = await waitingList();
    assert.equal(listed.open, listed.items.length, "one count rule");
    assert.equal(listed.open, 1);
    // Dispatching got the resident's own replies; from here on, answers and reads must add nothing to the conversation.
    const replies = await assistantLines();
    assert.equal((await web("/web/thread/say", { id: asked.id, text: "先做 A" })).status, 200);
    await until(async () => !(await waitingList()).items.some((i) => i.thread === asked.id && i.kind === "ask"), "the ask gone");
    assert.equal((await web("/web/waiting/seen", { all: true })).status, 200);
    assert.deepEqual((await waitingList()).items, []);
    await sleep(1500);
    assert.equal(await assistantLines(), replies, "nothing was said in the conversation");
  });

  await step("the stop button: the turn ends as stopped, not failed or done, and the list has nothing for it", async () => {
    const slow = await send("机器派活 SLOW 慢活");
    await until(async () => (await threadOf(slow.id)).status === "working", "working");
    await until(() => prompts().some((p) => p.text === "SLOW 慢活"), "the slow turn started");
    // The runner's progress: the thread's page and its row show what it is doing, while it works.
    const shown = await until(async () => { const v = await threadOf(slow.id); return v.steps?.length && v; }, "steps on the thread page");
    assert.equal(shown.steps.at(-1).title, "read look around");
    assert.equal((await web("/web/threads")).data.threads.find((t) => t.id === slow.id).steps.at(-1).title, "read look around");
    // Work sent while that turn runs waits in line, and says so, until the machine takes it up (the next step answers it:
    // a day has ten tasks at most, so it is not a task of its own).
    held = await send("机器派活 PERM:execute 跑一下");
    assert.equal(held.queued, true, "the thread's row says it waits in line");
    assert.equal((await threadOf(held.id)).tasks[0].queued, true);
    const stop = await web("/web/thread/stop", { id: slow.id });
    assert.equal(stop.status, 200, JSON.stringify(stop.data));
    const stopped = await until(async () => { const v = await threadOf(slow.id); return v.status === "stopped" && v; }, "stopped");
    await until(async () => (await threadOf(held.id)).tasks[0].queued === false, "the one behind taken up");
    assert.deepEqual(stopped.tasks.map((task) => task.status), ["stopped"]);
    assert.equal(stopped.steps, undefined, "no steps once it has stopped");
    assert.ok(!(await web("/web/waiting")).data.items.some((i) => i.thread === slow.id));
    // A stopped thread leaves a record in the conversation (the model sees it), not a reply and not on their page.
    await settled();
    assert.equal((await web("/web/say", { text: "机器记录几条" })).status, 200);
    const lines = (await web("/web/messages")).data.data;
    assert.match(lines.filter((line) => line.role === "assistant").at(-1).text, /机器记录 [1-9]/);
    assert.ok(!JSON.stringify(lines).includes("ran on their machine"), "not shown to them");
    assert.equal((await web("/web/thread/stop", { id: slow.id })).status, 400, "nothing running to stop");
  });

  await step("a permission the machine holds is on the waiting list with Allow / Deny; the button resolves it and clears the item", async () => {
    const waitingList = async () => (await web("/web/waiting")).data;
    const item = await until(async () => (await waitingList()).items.find((i) => i.thread === held.id && i.kind === "permission"), "the permission in the list");
    assert.match(item.perm, /^p_[0-9a-f]{10}$/);
    assert.ok(item.line && item.title);
    assert.equal((await web("/web/waiting/permission", { id: "p_0000000000", allow: true })).status, 409, "an unknown one");
    assert.equal((await web("/web/waiting/permission", { id: item.perm })).status, 400);
    const decided = await web("/web/waiting/permission", { id: item.perm, allow: true });
    assert.equal(decided.status, 200);
    const done = await until(async () => { const v = await threadOf(held.id); return v.status === "done" && v; }, "done after Allow");
    assert.match(done.lines.at(-1).text, /perm=allow/);
    assert.ok(!(await waitingList()).items.some((i) => i.kind === "permission"), "the item is gone");
    assert.equal((await web("/web/waiting/permission", { id: item.perm, allow: false })).status, 409, "answered once");
    await settled();
  });

  await step("revoked from the settings page: the runner is told 401 and stops", async () => {
    const id = (await web("/web/runner")).data.machine.id;
    assert.equal((await web("/web/runner/revoke", { runnerId: id })).status, 200);
    await until(() => runner.exitCode !== null, "the runner to exit", 15_000);
    assert.equal((await web("/web/runner")).data.machine, null);
  });
} finally {
  runner?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
