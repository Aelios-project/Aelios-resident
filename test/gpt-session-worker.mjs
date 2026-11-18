// Real Resident/Think worker with the mock Aelios. Keep the mock and state across both phases.
import assert from "node:assert/strict";

const worker = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const mock = "http://127.0.0.1:9999";
const headers = { "x-web-key": "test-web-key", "content-type": "application/json" };
const model = "chatgpt/gpt-5";

async function post(path, body) {
  const response = await fetch(`${worker}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

async function say(resident, text) {
  assert.equal((await post(`${resident}/web/say`, { text })).status, "completed");
}

async function calls(identity) {
  const log = await (await fetch(`${mock}/__log`)).json();
  return log.filter((entry) => entry.kind === "aelios.chat" && entry.identity === identity && entry.body.model === model && !entry.purpose);
}

if (process.argv[2] === "first") {
  const other = "/r/cache-room";
  await post("/web/residents", { id: "cache-room", name: "Cache Room" });
  await post("/web/model", { text: model });
  await post(`${other}/web/model`, { text: model });
  await say("", "First cache test turn");
  await say("", "Second cache test turn");
  await say(other, "Other resident cache test turn");

  const primaryCalls = await calls(null);
  const otherCalls = await calls("cache-room");
  assert.equal(primaryCalls.length, 2);
  assert.equal(otherCalls.length, 1);
  const id = primaryCalls[0].sessionId;
  assert.match(id ?? "", /^[a-f0-9]{64}$/, "primary Think session must send a nonempty identifier");
  assert.equal(primaryCalls[1].sessionId, id);
  assert.match(otherCalls[0].sessionId ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(otherCalls[0].sessionId, id);
  console.log("PASS real Think sessions keep a stable header across turns and separate different residents");
} else if (process.argv[2] === "restart") {
  const before = await calls(null);
  assert.equal(before.length, 2);
  await say("", "Cache test turn after restart");
  const after = await calls(null);
  assert.equal(after.length, 3);
  assert.match(before[0].sessionId ?? "", /^[a-f0-9]{64}$/);
  assert.equal(after[2].sessionId, before[0].sessionId);
  console.log("PASS a restarted Worker uses the same cache session header");
} else {
  throw new Error("expected first or restart");
}
