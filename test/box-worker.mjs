// A fake box dialing a real local Worker (the box hub Durable Object with hibernation): pairing with a code, the
// settings page's list, a turn through the socket into the chat, two boxes for one plug, revoking closing the socket at
// once, and the offline fallback to the default model with one line in the chat.
// Needs the mock server and `wrangler dev --config wrangler.test.jsonc` on a fresh state, like test/run.mjs.
// Usage: node test/box-worker.mjs
import assert from "node:assert/strict";
import { runLink } from "../acp-box/link.mjs";

const WORKER = "http://127.0.0.1:8787";
const KEY = "test-web-key";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const web = (path, body) =>
  fetch(`${WORKER}${path}`, { method: body ? "POST" : "GET", headers: { "x-web-key": KEY, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (path, body) => (await web(path, body)).json();

let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function until(check, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await sleep(100);
  }
}

const turns = [];
const engines = (label) => ({
  kiro: { check: async () => null, turn: async (body, write) => (turns.push({ label, body }), write({ text: `来自盒子${label}` }), write({ done: { credits: 0.1 } })) },
  claude: { check: async () => "No Claude setup token on this machine", turn: async () => {} }
});
async function pairAndConnect(label) {
  const { code } = await json("/web/boxes/code", {});
  const response = await fetch(`${WORKER}/box/v1/pair`, { method: "POST", body: JSON.stringify({ code, name: label }) });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const link = runLink({ url: `${WORKER.replace("http", "ws")}/box/v1/link`, token, name: label, engines: engines(label), backoff: { min: 200, max: 1000 } });
  return { code, token, link };
}
const lastReply = async () => {
  const messages = (await json("/web/messages")).data ?? [];
  return messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
};

let a, b;
await step("pairing needs the web key for the code; the code works once; a wrong one is refused", async () => {
  assert.equal((await fetch(`${WORKER}/web/boxes/code`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${WORKER}/box/v1/pair`, { method: "POST", body: JSON.stringify({ code: "AAAA-BBBB", name: "x" }) })).status, 403);
  a = await pairAndConnect("甲");
  const again = await fetch(`${WORKER}/box/v1/pair`, { method: "POST", body: JSON.stringify({ code: a.code, name: "x" }) });
  assert.equal(again.status, 403);
});

await step("the list shows the box online with its plugs, and the plug that is down with why", async () => {
  const box = await until(async () => (await json("/web/boxes")).boxes.find((one) => one.online));
  assert.equal(box.name, "甲");
  assert.deepEqual(box.plugs, ["kiro"]);
  assert.match(box.unavailable.claude, /No Claude setup token/);
  assert.deepEqual(box.serves, ["kiro"]);
});

await step("a kiro/ model's turn goes down the socket and the reply comes back into the chat", async () => {
  const set = await json("/web/model", { text: "kiro/auto" });
  assert.ok(!set.error, JSON.stringify(set));
  const said = await web("/web/say", { text: "你好" });
  assert.equal(said.status, 200);
  assert.match(await lastReply(), /来自盒子甲/);
  const turn = turns.at(-1);
  assert.equal(turn.body.model, "auto");
  assert.ok(!["key", "token", "apiKey", "helper"].some((name) => name in turn.body) && !JSON.stringify(turn.body).includes("ksk_"), "no credential or helper choice in the turn");
});

await step("two boxes offer kiro: the newest serves, and the owner can pick the other", async () => {
  b = await pairAndConnect("乙");
  const boxes = await until(async () => {
    const list = (await json("/web/boxes")).boxes;
    return list.length === 2 && list.every((one) => one.online) ? list : null;
  });
  const [first, second] = boxes;
  assert.deepEqual(second.serves, ["kiro"], "the most recently connected");
  await web("/web/say", { text: "再来" });
  assert.match(await lastReply(), /来自盒子乙/);
  assert.equal((await json("/web/boxes/serve", { plug: "kiro", id: first.id })).ok, true);
  await web("/web/say", { text: "再来一次" });
  assert.match(await lastReply(), /来自盒子甲/);
  assert.equal((await web("/web/boxes/serve", { plug: "kiro", id: "nope" })).status, 400);
});

await step("revoking closes the socket at once, and the old token is turned away for good", async () => {
  const boxes = (await json("/web/boxes")).boxes;
  const mine = boxes.find((one) => one.name === "甲");
  assert.equal((await json("/web/boxes/revoke", { id: mine.id })).ok, true);
  assert.deepEqual(await Promise.race([a.link.finished, sleep(5000).then(() => "still open")]), { revoked: true });
  assert.equal((await json("/web/boxes")).boxes.length, 1);
});

await step("with no box online the turn runs on the default model and the chat says the box is offline", async () => {
  b.link.stop();
  await until(async () => !(await json("/web/boxes")).boxes.some((one) => one.online), 15000);
  const before = (await json("/web/messages")).data.length;
  const said = await web("/web/say", { text: "还在吗" });
  assert.equal(said.status, 200);
  const after = await json("/web/messages");
  assert.ok(after.data.length > before);
  assert.doesNotMatch(await lastReply(), /来自盒子/);
  assert.match(JSON.stringify(after), /盒子不在线/);
});

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
