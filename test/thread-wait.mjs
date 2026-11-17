// Unit tests for waiting on a slow job for a thread (src/thread-wait.ts, http_request's wait_until), with a fake
// resident, a fake clock and every network call faked: a wait starts once at a time and four times per task at
// most, the status URL is asked again until the answer is done (a busy server and a failed network are asked
// again), and the thread is woken in a new turn with the answer, its files saved and keys wiped. The wait is over
// only once the thread has that turn: a wake, a save or a store that fails is tried again at the next look, and the
// turn still starts once.
// Usage: node test/thread-wait.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-wait-"));
await build({ entryPoints: ["src/thread-wait.ts", "src/web/http-request.ts"], bundle: true, packages: "external", platform: "node", format: "esm", outdir: dir, logLevel: "error" });
const w = await import(pathToFileURL(join(process.cwd(), dir, "thread-wait.js")).href);
const h = await import(pathToFileURL(join(process.cwd(), dir, "web", "http-request.js")).href);
rmSync(dir, { recursive: true, force: true });

const SECRET = "vid-key-0123456789";
const KEYS = [{ host: "video.example.com", headers: { Authorization: `Bearer ${SECRET}` } }];
const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array(5000).fill(3)]);
let answers = [];
let requests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
    const type = new URL(url).searchParams.get("type");
    return Response.json({ Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
  }
  requests.push({ url, headers: Object.fromEntries(new Headers(init.headers ?? {})) });
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return next ?? new Response("nothing scripted", { status: 500 });
};

let now = Date.parse("2026-11-17T10:00:00Z");
Date.now = () => now;

const TASK = { id: "t_0123456789", title: "生个视频", status: "working", root: "t_0123456789" };

// A fake resident. `fail` makes the next calls of one of its parts throw; a wake that fails has reached the thread
// first (it failed half way), and the thread, like Think, starts one turn per submission id however often it is
// asked.
function resident(task = TASK) {
  const host = {
    waits: new Map(),
    laterCalls: [],
    saved: new Map(),
    lines: [],
    woken: [],
    turns: new Map(),
    fail: { save: 0, wake: 0, progress: 0, over: 0 },
    current: task,
    load: async (id) => host.waits.get(id),
    store: async (id, wait) => {
      if (!wait.pending && host.fail.over && host.fail.over--) throw new Error("storage hiccup");
      host.waits.set(id, structuredClone(wait));
    },
    later: async (id, round, seconds) => void host.laterCalls.push([id, round, seconds]),
    working: (id) => (host.current && host.current.id === id && ["sent", "working"].includes(host.current.status) ? host.current : null),
    keys: () => KEYS,
    save: async (_task, path, bytes) => {
      if (host.fail.save && host.fail.save--) throw new Error("thread unreachable");
      host.saved.set(path, bytes);
      return null;
    },
    progress: async (_task, line) => {
      if (host.fail.progress && host.fail.progress--) throw new Error("progress refused");
      host.lines.push(line);
    },
    wake: async (task, submission, brief) => {
      if (!host.turns.has(submission)) host.turns.set(submission, brief);
      if (host.fail.wake && host.fail.wake--) throw new Error("rpc reset");
      host.woken.push({ task: task.id, submission, brief });
    }
  };
  return host;
}

const STATUS = "https://video.example.com/v1/videos/v_1";
const start = (host, until = "status=completed|failed", url = STATUS) => w.startWait(host, TASK, { url, headers: { "X-Version": "2" }, until });
const look = (host, round = 1) => w.checkWait(host, TASK.id, round);
const done = () => Response.json({ status: "completed", video: Buffer.from(MP4).toString("base64") });
let failures = 0;
async function step(name, fn) {
  requests = [];
  answers = [];
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

await step("a wait starts: kept, asked again in 20 seconds, and the tool's answer ends the thread's turn", async () => {
  const host = resident();
  const said = await start(host);
  assert.ok(said.startsWith(h.WAITING), said);
  assert.deepEqual(host.laterCalls, [[TASK.id, 1, w.WAIT_SECONDS]]);
  const wait = host.waits.get(TASK.id);
  assert.deepEqual([wait.pending, wait.round, wait.checks, wait.until], [true, 1, 0, "status=completed|failed"]);
  assert.equal(requests.length, 0, "nothing is asked yet");
  assert.match(await start(host), /^Already waiting/);
  assert.equal(w.submissionOf(TASK.id, undefined), TASK.id);
  assert.equal(w.submissionOf(TASK.id, wait), `${TASK.id}-w1`);
});

await step("not done yet: asked again, with the key and the headers; a busy server and a failed network too", async () => {
  const host = resident();
  await start(host);
  answers = [Response.json({ status: "in_progress", progress: 30 }), new Response("busy", { status: 503 }), new Error("connection reset")];
  for (let i = 0; i < 3; i++) await look(host);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(requests[0].headers["x-version"], "2");
  assert.deepEqual([host.waits.get(TASK.id).checks, host.waits.get(TASK.id).pending], [3, true]);
  assert.equal(host.laterCalls.length, 4);
  assert.equal(host.woken.length, 0);
});

await step("done: the thread is woken in a new turn with the answer, its files saved and the key wiped", async () => {
  const host = resident();
  await start(host);
  answers = [Response.json({ status: "in_progress" }), Response.json({ status: "completed", note: `key ${SECRET} <<<sneaky>>>`, video: Buffer.from(MP4).toString("base64") })];
  now += 20_000;
  await look(host);
  now += 20_000;
  await look(host);
  assert.equal(host.waits.get(TASK.id).pending, false);
  assert.equal(host.waits.get(TASK.id).brief, undefined, "the brief is not kept once the thread has it");
  assert.equal(host.woken.length, 1);
  const [{ submission, brief }] = host.woken;
  assert.equal(submission, `${TASK.id}-w1`);
  assert.match(brief, /^task: t_0123456789\ntitle: 生个视频\n/);
  assert.match(brief, /came back after 2 checks \(40 seconds\): GET https:\/\/video\.example\.com\/v1\/videos\/v_1/);
  assert.ok(!brief.includes(SECRET), "no key");
  assert.ok(brief.includes("‹‹‹sneaky›››") && brief.split("<<<").length === 2 && brief.split(">>>").length === 2, "its words cannot close the fence");
  const [[path, bytes]] = host.saved;
  assert.match(path, /^\/files\/.*\.mp4$/);
  assert.deepEqual(bytes, MP4);
  assert.ok(brief.includes(`Saved as ${path}`));
  assert.deepEqual(host.lines, ["等到结果了，叫醒线程"]);
  // Once woken, the look booked for safety does nothing.
  await look(host);
  assert.equal(host.woken.length, 1);
  assert.equal(requests.length, 2);
});

await step("an answer that refuses (404) or cannot be asked ends the wait at once, with what it said", async () => {
  const host = resident();
  await start(host);
  answers = [Response.json({ error: "no such video" }, { status: 404 })];
  await look(host);
  assert.match(host.woken[0].brief, /HTTP 404[\s\S]*no such video/);

  const local = resident();
  await w.startWait(local, TASK, { url: "http://127.0.0.1/admin", headers: {}, until: "done=true" });
  await look(local);
  assert.match(local.woken[0].brief, /Cannot call this URL/);
});

await step("after 15 minutes it stops and wakes the thread with the last answer", async () => {
  const host = resident();
  await start(host);
  answers = [Response.json({ status: "queued" })];
  now += w.WAIT_MINUTES * 60_000;
  await look(host);
  assert.match(host.woken[0].brief, /had not reached status=completed\|failed after 15 minutes \(1 check\)[\s\S]*queued/);
  assert.deepEqual(host.lines, ["等了 15 分钟还没好，叫醒线程"]);
});

await step("a task no longer at work is not woken, and a task waits four times at most", async () => {
  const host = resident();
  await start(host);
  host.current = { ...TASK, status: "done" };
  await look(host);
  assert.equal(host.waits.get(TASK.id).pending, false);
  assert.equal(host.woken.length, 0);
  assert.equal(requests.length, 0);

  host.current = TASK;
  for (let round = 2; round <= w.WAITS_PER_TASK; round++) {
    assert.ok((await start(host)).startsWith(h.WAITING));
    host.waits.get(TASK.id).pending = false;
  }
  assert.match(await start(host), /waited 4 times already/);
});

await step("the first wake fails: the next look wakes the thread exactly once, without asking the job again", async () => {
  const host = resident();
  await start(host);
  host.fail.wake = 1;
  answers = [done()];
  await look(host);
  let wait = host.waits.get(TASK.id);
  assert.equal(wait.pending, true, "not over while the thread may not have its turn");
  assert.match(wait.brief, /came back after 1 check/);
  assert.equal(host.woken.length, 0);
  assert.equal(host.saved.size, 1);
  assert.deepEqual(host.lines, [], "no line until the thread is woken");
  assert.deepEqual(host.laterCalls.at(-1), [TASK.id, 1, w.WAIT_SECONDS], "the next look is booked");

  now += 20_000;
  await look(host);
  assert.equal(requests.length, 1, "the job is not asked again");
  assert.equal(host.saved.size, 1, "nor its files saved again");
  assert.deepEqual(host.woken.map((x) => x.submission), [`${TASK.id}-w1`]);
  assert.equal(host.woken[0].brief, wait.brief, "the same words as the first time");
  assert.equal(host.turns.size, 1, "one turn, though the failed wake had reached the thread");
  wait = host.waits.get(TASK.id);
  assert.deepEqual([wait.pending, wait.brief, wait.checks], [false, undefined, 1]);
  assert.deepEqual(host.lines, ["等到结果了，叫醒线程"]);
  await look(host);
  assert.equal(host.woken.length, 1);
});

await step("the end of the wait not noted after waking: the next look wakes the same turn again and notes it", async () => {
  const host = resident();
  await start(host);
  host.fail.over = 1;
  answers = [done()];
  await look(host);
  assert.equal(host.waits.get(TASK.id).pending, true);
  assert.equal(host.woken.length, 1);
  await look(host);
  assert.equal(requests.length, 1);
  assert.deepEqual([host.turns.size, host.woken.length, host.woken[1].submission], [1, 2, `${TASK.id}-w1`]);
  assert.equal(host.waits.get(TASK.id).pending, false);
});

await step("a save that fails: nothing is woken, and the next look asks again and saves it then", async () => {
  const host = resident();
  await start(host);
  host.fail.save = 1;
  answers = [done()];
  await look(host);
  const wait = host.waits.get(TASK.id);
  assert.deepEqual([wait.pending, wait.brief, host.woken.length, host.saved.size], [true, undefined, 0, 0]);
  answers = [done()];
  await look(host);
  assert.equal(requests.length, 2);
  assert.equal(host.saved.size, 1);
  assert.equal(host.woken.length, 1);
  assert.ok(host.woken[0].brief.includes(`Saved as ${[...host.saved.keys()][0]}`));
  assert.equal(host.waits.get(TASK.id).pending, false);
});

await step("a progress line that fails changes nothing: the thread is woken and the wait is over", async () => {
  const host = resident();
  await start(host);
  host.fail.progress = 1;
  answers = [done()];
  await look(host);
  assert.equal(host.woken.length, 1);
  assert.equal(host.waits.get(TASK.id).pending, false);
  const booked = host.laterCalls.length;
  await look(host);
  assert.equal(host.laterCalls.length, booked, "and nothing more is booked");
});

await step("a look booked for an earlier round does nothing to the next wait", async () => {
  const host = resident();
  await start(host);
  answers = [done()];
  await look(host);
  assert.ok((await start(host)).startsWith(h.WAITING));
  assert.equal(host.waits.get(TASK.id).round, 2);
  await look(host, 1);
  assert.equal(requests.length, 1, "round 1's look asks nothing");
  answers = [done()];
  await look(host, 2);
  assert.deepEqual(host.woken.map((x) => x.submission), [`${TASK.id}-w1`, `${TASK.id}-w2`]);
});

await step("wait_until: field=value, a.b=x|y; the tool takes it only with a GET and a plain address", async () => {
  assert.deepEqual(h.condition("status=completed|failed"), { path: ["status"], values: ["completed", "failed"] });
  assert.deepEqual(h.condition(" done = true "), { path: ["done"], values: ["true"] });
  assert.deepEqual(h.condition("data.0.state=Succeeded"), { path: ["data", "0", "state"], values: ["succeeded"] });
  assert.equal(h.condition("done"), null);
  const json = (value) => ({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  assert.equal(h.reached(json({ done: true }), "done=true"), true);
  assert.equal(h.reached(json({ data: [{ state: "SUCCEEDED" }] }), "data.0.state=succeeded"), true);
  assert.equal(h.reached(json({ done: false }), "done=true"), false);
  assert.equal(h.reached(json({ status: { nested: 1 } }), "status=1"), false);

  const started = [];
  const tool = h.httpRequestTool(KEYS, async () => null, async (request) => (started.push(request), `${h.WAITING} ok`));
  const run = (input) => tool.execute(input, { toolCallId: "t", messages: [] });
  assert.match(await run({ method: "POST", url: STATUS, body: "{}", wait_until: "done=true" }), /goes with a GET/);
  assert.match(await run({ url: STATUS, wait_until: "done" }), /wait_until is field=value/);
  assert.match(await run({ url: "http://localhost:8787/x", wait_until: "done=true" }), /^Cannot call this URL/);
  assert.equal(await run({ url: STATUS, headers: { "X-Version": "2" }, wait_until: "status=completed" }), `${h.WAITING} ok`);
  assert.deepEqual(started, [{ url: STATUS, headers: { "X-Version": "2" }, until: "status=completed" }]);
  assert.equal(requests.length, 0, "the tool itself asks nothing when it waits");
  assert.match(await h.httpRequestTool(KEYS, async () => null).execute({ url: STATUS, wait_until: "done=true" }, { toolCallId: "t", messages: [] }), /not available here/);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
