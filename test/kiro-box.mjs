// The kiro/… models without a Worker or a real key: what goes to the Kiro box (src/kiro-box.ts) and the box itself
// (kiro-box/), run against a fake kiro-cli process. Usage: node test/kiro-box.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-kiro-box-"));
await build({ entryPoints: ["src/kiro-box.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "kiro-box.mjs"), logLevel: "error" });
const worker = await import(pathToFileURL(join(process.cwd(), dir, "kiro-box.mjs")).href);
const agent = await import(pathToFileURL(join(process.cwd(), "kiro-box/agent.mjs")).href);
const server = await import(pathToFileURL(join(process.cwd(), "kiro-box/server.mjs")).href);

const KEY = "ksk_test_0123456789abcdefghij";
// A stand-in for kiro-cli: writes down what it was started with, then answers in stream-json (or fails).
const work = mkdtempSync(join(tmpdir(), "fake-kiro-"));
const seen = join(work, "seen.json");
const fake = join(work, "kiro-cli");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("node:fs");
const home = process.env.HOME;
const agentFile = home + "/.kiro/agents/resident.json";
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), env: process.env,
  agent: JSON.parse(fs.readFileSync(agentFile, "utf8")),
  cwdHasKiro: fs.existsSync(process.cwd() + "/.kiro")
}));
if (process.argv.includes("fail please")) { console.error("401 unauthorized for " + process.env.KIRO_API_KEY); process.exit(1); }
const chunk = (text) => JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
console.log(JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "shell" } } }));
console.log(chunk("Hello "));
console.log(chunk("there"));
console.log(JSON.stringify({ metadata: { unit: "credit", unitPlural: "credits", usage: 0.25 } }));
`
);
chmodSync(fake, 0o755);
process.env.KIRO_BIN = fake;
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

async function turn(extra = {}) {
  const out = [];
  await server.runTurn({ key: KEY, model: "auto", system: "You are the resident.", prompt: "User: hi", ...extra }, (object) => out.push(object));
  return out;
}

await step("the generated agent has exactly the stripped-down fields", () => {
  assert.deepEqual(agent.agentConfig("SYSTEM"), {
    name: "resident",
    description: "The resident, talking only.",
    prompt: "SYSTEM",
    tools: [],
    allowedTools: [],
    mcpServers: {},
    includeMcpJson: false,
    resources: []
  });
  assert.ok(Array.isArray(agent.agentConfig("x").tools), "tools is an explicit list, never left out");
});

await step("the command line trusts nothing and runs headless", () => {
  const args = agent.kiroArgs("auto", "User: hi");
  assert.ok(args.includes("--no-interactive") && args.includes("--trust-tools="));
  assert.ok(!args.some((arg) => /trust-all|^-a$/.test(arg)));
  assert.equal(agent.kiroArgs("auto", "-x").at(-1), " -x", "a prompt cannot look like a flag");
  assert.equal(server.problem({ key: KEY, model: "--evil", prompt: "x" }) !== null, true);
});

await step("a turn goes in and a reply comes out, with the credits Kiro reports", async () => {
  const out = await turn();
  assert.deepEqual(out, [{ text: "Hello " }, { text: "there" }, { done: { credits: 0.25 } }]);
});

await step("kiro-cli runs stripped: the agent file, an empty folder, no other secrets", async () => {
  await turn({ system: "SYSTEM PROMPT" });
  const run = JSON.parse(readFileSync(seen, "utf8"));
  assert.deepEqual(run.agent, agent.agentConfig("SYSTEM PROMPT"));
  assert.equal(run.cwdHasKiro, false);
  assert.equal(run.env.KIRO_API_KEY, KEY);
  assert.equal(run.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(run.args.includes("--trust-tools=") && run.args.includes("--agent") && run.args.includes("resident"));
  assert.equal(run.env.HOME.startsWith(tmpdir()) || run.env.HOME.includes("kiro-box-"), true, "its own home, not the machine's");
});

await step("a missing key is one clear line, before anything starts", () => {
  const why = server.problem({ model: "auto", prompt: "x" });
  assert.match(why, /^KIRO_API_KEY is not set/);
  assert.ok(!why.includes("\n"));
});

await step("the key is never echoed back, even when kiro-cli prints it", async () => {
  const out = await turn({ prompt: "fail please" });
  assert.equal(out.length, 1);
  assert.ok(out[0].error);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

await step("the Worker side: a turn becomes the Messages API stream, and the key stays out of the error", async () => {
  const sent = [];
  const boxReply = (lines) => new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const turnWith = (lines, key = KEY, extra = {}) => ({ key, send: async (body) => (sent.push(JSON.parse(body)), boxReply(lines)), ...extra });
  const request = (stream) => ({ method: "POST", body: JSON.stringify({ model: "auto", stream, system: "SYS", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
  const credits = [];
  const ok = await worker.kiroFetch(turnWith([{ text: "Hello" }, { text: "!" }, { done: { credits: 0.5 } }], KEY, { credits: (n) => credits.push(n) }))("x", request(false));
  const message = await ok.json();
  assert.equal(message.content[0].text, "Hello!");
  assert.deepEqual(credits, [0.5]);
  assert.equal(sent[0].key, KEY);
  assert.equal(sent[0].system, "SYS");
  assert.match(sent[0].prompt, /User: hi/);
  assert.equal(sent[0].tools, undefined, "no tools go to Kiro");
  const streamed = await (await worker.kiroFetch(turnWith([{ text: "Hi" }, { done: { credits: null } }]))("x", request(true))).text();
  assert.match(streamed, /text_delta/);
  assert.match(streamed, /message_stop/);
  const refused = await worker.kiroFetch(turnWith([{ error: `401 unauthorized ${KEY}` }]))("x", request(false));
  assert.ok(refused.status >= 400);
  assert.ok(!(await refused.text()).includes(KEY));
  const missing = await worker.kiroFetch(turnWith([], ""))("x", request(false));
  const text = (await missing.json()).error.message;
  assert.match(text, /^KIRO_API_KEY is not set/);
  assert.equal(sent.length, 3, "no key, no request to the box");
});

rmSync(dir, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
