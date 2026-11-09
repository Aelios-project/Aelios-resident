// The kiro/… models without a Worker or a real key: what goes to the ACP box (src/kiro-box.ts) and the box itself
// (acp-box/ with its Kiro plug), run against a fake `kiro-cli acp` (test/fake-acp.cjs). Usage: node test/kiro-box.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-kiro-box-"));
await build({ entryPoints: ["src/kiro-box.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "kiro-box.mjs"), logLevel: "error" });
const at = (path) => import(pathToFileURL(join(process.cwd(), path)).href);
const worker = await at(join(dir, "kiro-box.mjs"));
const kiro = await at("acp-box/plugs/kiro.mjs");
const prompt = await at("acp-box/prompt.mjs");
const box = await at("acp-box/kiro-turn.mjs");
const localServer = await at("acp-box/local.mjs");
const engines = await at("acp-box/engines.mjs");
const sessions = await at("acp-box/session.mjs");

const KEY = "ksk_test_0123456789abcdefghij";
const work = mkdtempSync(join(tmpdir(), "fake-kiro-"));
const LOG = join(work, "log.ndjson");
// The plug passes only a few names of the environment on, so the fake gets its log's address from a small wrapper.
const bin = join(work, "kiro-cli");
writeFileSync(bin, `#!/bin/sh\nFAKE_LOG=${JSON.stringify(LOG)} exec node ${JSON.stringify(join(process.cwd(), "test/fake-acp.cjs"))} "$@"\n`);
chmodSync(bin, 0o755);
process.env.KIRO_BIN = bin;
process.env.ANTHROPIC_API_KEY = "must-not-reach-kiro";

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

// The box's own engine, as the socket drives it: the key is the machine's, not the turn's.
const local = await localServer.startLocal();
const engine = engines.createEngines({ kiro: KEY }, { base: local.base }).kiro;
const TOOLS = [{ name: "start_thread", description: "Hand a job to a thread.", input_schema: { type: "object", properties: { job: { type: "string" } } } }];
const said = (who, text, mark) => ({ who, text, mark });
async function turn(body) {
  const lines = [];
  // A key or helper on the wire is overwritten by the box's own.
  await engine.turn({ model: "auto", system: "SYSTEM PROMPT", key: "from-the-wire", helper: "other", ...body }, (line) => lines.push(line), new AbortController().signal);
  return { lines };
}
const logged = () => readFileSync(LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const reset = () => writeFileSync(LOG, "");
reset();

await step("the generated agent is stripped, with only the resident's tool server when there are tools", () => {
  assert.deepEqual(kiro.agentConfig("SYSTEM"), { name: "resident", description: "The resident.", prompt: "SYSTEM", tools: [], allowedTools: [], mcpServers: {}, includeMcpJson: false, resources: [] });
  const tool = kiro.agentConfig("S", { url: "http://127.0.0.1:1/mcp/x", secret: "s", timeoutMs: 5 });
  assert.deepEqual(tool.tools, ["@resident"]);
  assert.deepEqual(tool.allowedTools, ["@resident"]);
  assert.deepEqual(Object.keys(tool.mcpServers), ["resident"]);
  assert.equal(tool.includeMcpJson, false);
});

await step("the command line is ACP, trusts only the resident's tools, never all", () => {
  assert.deepEqual(kiro.kiroArgs("auto", true), ["acp", "--agent", "resident", "--model", "auto", "--trust-tools=@resident"]);
  assert.equal(kiro.kiroArgs("auto", false).at(-1), "--trust-tools=");
  assert.equal(box.problem({ key: KEY, model: "--evil", system: "", messages: [said("User", "x")] }) !== null, true);
  assert.match(box.problem({ model: "auto", system: "", messages: [said("User", "x")] }), /^KIRO_API_KEY is not set on the box machine/);
});

await step("the local-login test switch is off by default", async () => {
  const home = mkdtempSync(join(work, "home-"));
  await kiro.copyLogin(home, {});
  assert.deepEqual(readdirSync(home), [], "nothing of the machine's own login is copied");
});

await step("a seeded turn streams text and the credits; kiro-cli runs stripped", async () => {
  const out = await turn({ conversation: "c1", tools: TOOLS, messages: [said("User", "hi", "m1")] });
  assert.deepEqual(out.lines, [{ text: "Hello " }, { text: "there" }, { done: { credits: 0.25 } }]);
  const [start, , ] = logged();
  assert.equal(start.start.env.KIRO_API_KEY, KEY);
  assert.equal(start.start.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(start.start.cwdHasKiro, false);
  assert.equal(start.start.agent.prompt, "SYSTEM PROMPT");
  assert.ok(start.start.args.includes("--trust-tools=@resident"));
  assert.match(logged().find((entry) => entry.prompt).prompt.text, /The conversation so far[\s\S]*User: hi/);
});

await step("the next turn goes to the same live session with only the new message", async () => {
  reset();
  const out = await turn({ conversation: "c1", tools: TOOLS, messages: [said("User", "hi", "m1"), said("You", "Hello there", "m2"), said("User", "again", "m3")] });
  assert.equal(out.lines.at(-1).done.credits, 0.25);
  const entries = logged();
  assert.equal(entries.filter((entry) => entry.start).length, 0, "no new process");
  assert.deepEqual(entries.find((entry) => entry.prompt).prompt, { sessionId: "s1", text: "User: again" });
});

await step("a compacted conversation drops the session and seeds a new one", async () => {
  reset();
  await turn({ conversation: "c1", tools: TOOLS, messages: [said("User", "[handover letter]", "x1"), said("User", "next", "x2")] });
  const entries = logged();
  assert.equal(entries.filter((entry) => entry.start).length, 1);
  assert.match(entries.find((entry) => entry.prompt).prompt.text, /handover letter[\s\S]*next/);
});

await step("a tool call stops the reply, the result answers it, and the same session goes on", async () => {
  reset();
  const first = await turn({ conversation: "c2", tools: TOOLS, messages: [said("User", "please hand off", "t1")] });
  const call = first.lines.find((line) => line.tool)?.tool;
  assert.equal(call?.name, "start_thread");
  assert.deepEqual(call.input, { job: "notes" });
  assert.deepEqual(first.lines.at(-1), { done: { credits: null } });
  assert.deepEqual(logged().find((entry) => entry.listed).listed, ["start_thread"]);
  const second = await turn({
    conversation: "c2",
    tools: TOOLS,
    messages: [said("User", "please hand off", "t1"), said("You", "On it.", "t2"), said("User", "[the tool's result]\nthread 12", "t3")],
    results: [{ type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "thread 12" }] }]
  });
  assert.deepEqual(second.lines, [{ text: "Tool said: thread 12" }, { done: { credits: 0.25 } }]);
  assert.equal(logged().filter((entry) => entry.prompt).length, 1, "the result went to the waiting call, not as a new prompt");
});

await step("a thought chunk goes on as a thought line; other updates are ignored", async () => {
  const out = await turn({ messages: [said("User", "think please", "t1")] });
  assert.deepEqual(out.lines, [{ thought: "Hmm. " }, { text: "Done." }, { done: { credits: 0.25 } }]);
});

await step("the Worker side: thought lines become a thinking block before the text, and old boxes still work", async () => {
  const reply = (lines) => ({ send: async () => new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n") });
  const ask = (lines, stream) => worker.kiroFetch(reply(lines))("x", { method: "POST", body: JSON.stringify({ model: "auto", stream, system: "SYS", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
  const lines = [{ thought: "Let me " }, { thought: "see." }, { text: "Hi" }, { done: { credits: 0.1, extra: "ignored" } }];
  const ok = await (await ask(lines, false)).json();
  assert.deepEqual(ok.content, [{ type: "thinking", thinking: "Let me see." }, { type: "text", text: "Hi" }]);
  const streamed = await (await ask(lines, true)).text();
  assert.match(streamed, /"type":"thinking"[\s\S]*thinking_delta[\s\S]*content_block_stop[\s\S]*"type":"text"/);
  const thoughtOnly = await (await ask([{ thought: "Hm" }, { done: { credits: null } }], false)).json();
  assert.deepEqual(thoughtOnly.content, [{ type: "thinking", thinking: "Hm" }]);
});

await step("the key is never echoed back, even when kiro-cli prints it", async () => {
  const out = await turn({ messages: [said("User", "fail please", "f1")] });
  assert.ok(out.lines.at(-1).error);
  assert.ok(!JSON.stringify(out.lines).includes(KEY));
});

await step("prompt.plan resumes only when the marks still match", () => {
  const messages = [said("User", "a", "1"), said("You", "b", "2"), said("User", "c", "3")];
  assert.deepEqual(prompt.plan(messages, { count: 1, hash: "1" }).input, "User: c");
  assert.equal(prompt.plan(messages, { count: 1, hash: "other" }).resume, false);
  assert.equal(prompt.plan(messages, { count: 3, hash: "3" }).resume, false, "nothing new");
});

await step("the Worker side: messages with marks and tools go out; tool lines come back as tool_use", async () => {
  const sent = [];
  const boxReply = (lines) => new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const turnWith = (lines, extra = {}) => ({ conversation: "default", send: async (body) => (sent.push(JSON.parse(body)), boxReply(lines)), ...extra });
  const request = (stream, messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }]) => ({
    method: "POST",
    body: JSON.stringify({ model: "auto", stream, system: "SYS", tools: [{ name: "start_thread", input_schema: { type: "object" } }], messages })
  });
  const credits = [];
  const ok = await (await worker.kiroFetch(turnWith([{ text: "Hello" }, { text: "!" }, { done: { credits: 0.5 } }], { credits: (n) => credits.push(n) }))("x", request(false))).json();
  assert.equal(ok.content[0].text, "Hello!");
  assert.equal(ok.stop_reason, "end_turn");
  assert.deepEqual(credits, [0.5]);
  assert.equal(sent[0].conversation, "default");
  assert.equal(sent[0].messages[0].who, "User");
  assert.match(sent[0].messages[0].mark, /^[0-9a-f]{64}$/);
  assert.equal(sent[0].tools[0].name, "start_thread");
  const called = await (await worker.kiroFetch(turnWith([{ text: "On it" }, { tool: { id: "toolu_1", name: "start_thread", input: { job: "x" } } }, { done: { credits: null } }]))("x", request(false))).json();
  assert.equal(called.stop_reason, "tool_use");
  assert.deepEqual(called.content[1], { type: "tool_use", id: "toolu_1", name: "start_thread", input: { job: "x" } });
  const results = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "start_thread", input: { job: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] }
  ];
  const streamed = await (await worker.kiroFetch(turnWith([{ text: "Hi" }, { done: { credits: null } }]))("x", request(true, results))).text();
  assert.match(streamed, /text_delta/);
  assert.match(streamed, /message_stop/);
  assert.deepEqual(sent.at(-1).results, [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "done" }] }]);
  const refused = await worker.kiroFetch(turnWith([{ error: "401 unauthorized" }]))("x", request(false));
  assert.ok(refused.status >= 400);
  assert.match((await refused.json()).error.message, /Kiro did not accept the API key[\s\S]*box machine/);
  assert.ok(sent.every((body) => !("key" in body) && !("helper" in body) && !JSON.stringify(body).includes(KEY)), "no credential in anything sent to the box");
});

await step("pictures reach ACP on seed and new turns; edited picture bytes invalidate the session", async () => {
  const image = (data, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data } });
  const user = (...content) => ({ role: "user", content });
  const words = (text) => ({ type: "text", text });
  const sent = [];
  const fetch = worker.kiroFetch({ conversation: "pictures", send: async (body) => {
    const data = JSON.parse(body);
    sent.push(data);
    const { lines } = await turn(data);
    return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  } });
  const ask = async (messages) => {
    const response = await fetch("x", { body: JSON.stringify({ model: "auto", system: "SYS", messages }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  reset();
  const first = user(words("look at these"), image("AAAA"), image("BBBB", "image/jpeg"));
  await ask([first]);
  const expected = [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }];
  assert.deepEqual(sent[0].messages[0].images, expected);
  assert.deepEqual(logged().find((entry) => entry.prompt).prompt.images, expected, "bytes and MIME types reach the helper, not just markers");
  const assistant = { role: "assistant", content: [words("Hello there")] };
  reset();
  await ask([first, assistant, user(words("again"))]);
  assert.equal(logged().filter((entry) => entry.start).length, 0);
  assert.equal(logged().find((entry) => entry.prompt).prompt.images, undefined, "known images are not resent");
  reset();
  await ask([first, assistant, user(words("again")), assistant, user(image("CCCC"))]);
  assert.deepEqual(logged().find((entry) => entry.prompt).prompt.images, [{ type: "image", data: "CCCC", mimeType: "image/png" }], "image-only turns work");
  reset();
  const edited = user(words("look at these"), image("DDDD"), image("BBBB", "image/jpeg"));
  await ask([edited, assistant, user(words("again"))]);
  assert.notEqual(sent[0].messages[0].mark, sent.at(-1).messages[0].mark, "the same text with a changed picture has a different mark");
  assert.equal(logged().filter((entry) => entry.start).length, 1, "edited history seeds a new session");
  assert.equal(logged().find((entry) => entry.prompt).prompt.images[0].data, "DDDD");
});

await step("prompt images follow their own message and leave with trimmed history; malformed images are rejected", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const messages = [{ ...said("User", "first", "1"), images: [image] }, said("You", "reply", "2"), { ...said("User", "", "3"), images: [image] }];
  const seed = prompt.plan(messages, null).seed;
  assert.equal(seed[1].text, "User: first");
  assert.deepEqual(seed[2], image);
  assert.equal(seed[3].text, "\n\nYou: reply");
  assert.deepEqual(seed.at(-1), image);
  const trimmed = prompt.plan([messages[0], said("User", "x".repeat(prompt.PROMPT_MAX_CHARS + 1), "4")], null).seed;
  assert.ok(!trimmed.some((block) => block.type === "image"), "an image outside the retained text window is omitted");
  assert.equal(prompt.messagesProblem([{ ...messages[0], images: [{ type: "image", data: 42 }] }], true), "a message has malformed images");
  assert.equal(prompt.messagesProblem([said("User", "legacy", "1")], true), null, "text-only old senders still work");
});

await step("a helper without image capability fails visibly without sending a prompt", async () => {
  reset();
  const out = await turn({ system: "NO_IMAGES", messages: [{ ...said("User", "look", "1"), images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }] });
  assert.match(out.lines.at(-1).error, /does not support image prompts/);
  assert.equal(logged().filter((entry) => entry.prompt).length, 0);
});

await step("dropping a session stops its process and removes its home", async () => {
  const live = [...sessions.byAddress.values()];
  assert.ok(live.length >= 1);
  const homes = live.map((session) => session.home);
  await Promise.all(live.map((session) => session.drop("the box stopped")));
  assert.ok(homes.every((home) => !existsSync(home)));
  assert.equal(sessions.byConversation.size, 0);
});

local.server.close();
local.server.closeAllConnections?.();
rmSync(dir, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
