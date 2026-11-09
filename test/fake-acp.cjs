#!/usr/bin/env node
// A stand-in for `kiro-cli acp` (test/kiro-box.mjs): an ACP agent over stdio that writes down what it was started
// with and every prompt, answers in agent_message_chunk updates, and calls the resident's MCP server when asked.
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const home = process.env.HOME;
const agent = JSON.parse(fs.readFileSync(`${home}/.kiro/agents/resident.json`, "utf8"));
log({ start: { args: process.argv.slice(2), cwd: process.cwd(), env: process.env, agent, cwdHasKiro: fs.existsSync(`${process.cwd()}/.kiro`) } });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
let sessions = 0;

async function callTool(name, args) {
  const server = agent.mcpServers.resident;
  const post = (body) => fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...server.headers }, body: JSON.stringify(body) });
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const listed = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  log({ listed: listed.result.tools.map((tool) => tool.name) });
  return (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json();
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (method === "session/new") return send({ id, result: { sessionId: `s${(sessions += 1)}` } });
  if (method !== "session/prompt") return id === undefined ? undefined : send({ id, error: { code: -32601, message: "no" } });
  const text = params.prompt.map((block) => block.text).join("");
  log({ prompt: { sessionId: params.sessionId, text } });
  if (text.includes("fail please")) {
    process.stderr.write(`401 unauthorized for ${process.env.KIRO_API_KEY}\n`);
    process.exit(1);
  }
  if (text.includes("hand off")) {
    chunk(params.sessionId, "On it. ");
    const result = await callTool("start_thread", { job: "notes" });
    chunk(params.sessionId, `Tool said: ${result.result.content[0].text}`);
  } else if (text.includes("think please")) {
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm. " } } } });
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "plan", entries: [] } } });
    chunk(params.sessionId, "Done.");
  } else {
    chunk(params.sessionId, "Hello ");
    chunk(params.sessionId, "there");
  }
  send({ method: "_kiro.dev/metadata", params: { sessionId: params.sessionId, meteringUsage: [{ value: 0.25, unit: "credit", unitPlural: "credits" }] } });
  send({ id, result: { stopReason: "end_turn" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
