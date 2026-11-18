// Exercise the actual ChatGPT adapter through AI SDK and the web activity projection.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { generateText, streamText, jsonSchema, stepCountIs, tool } from "ai";
import { applyChunkToParts } from "agents/chat";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync("node_modules/.cache/gpt-reasoning-");
const out = join(dir, "test.mjs");
await build({ stdin: { contents: 'export { aeliosModel } from "./src/via-aelios.ts"; export { activityOf, WebDraft } from "./src/web/history.ts"; export { entryOf } from "./src/usage.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { aeliosModel, activityOf, WebDraft, entryOf } = await import(pathToFileURL(resolve(out)).href);
// Resolve the exact temporary directory created above before removing it.
rmSync(resolve(dir), { recursive: true, force: true });
const memory = { url: "https://memory.example", key: "fixture", namespace: "default", identity: "test" };
const usage = { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050, prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 1536 }, completion_tokens_details: { reasoning_tokens: 30 } };
const reasoning = "Checked the result.";
const call = { id: "call-1", type: "function", function: { name: "ping", arguments: '{"value":1}' } };
function answer(stream, first, summary) {
  const message = { role: "assistant", content: first ? null : "OK", ...(summary ? { reasoning_content: reasoning } : {}), ...(first ? { tool_calls: [call] } : {}) };
  if (!stream) return Response.json({ id: "fixture", object: "chat.completion", created: 0, model: "gpt-6.2-sol", choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }], usage });
  const chunk = (delta, finish_reason = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "gpt-6.2-sol", choices: [{ index: 0, delta, finish_reason }] });
  const events = [chunk({ role: "assistant" }), ...(summary ? [chunk({ reasoning_content: reasoning })] : []), first ? chunk({ tool_calls: [{ index: 0, ...call }] }) : chunk({ content: "OK" }), chunk({}, first ? "tool_calls" : "stop"), { ...chunk({}), choices: [], usage }];
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const realFetch = globalThis.fetch;
try {
  for (const id of ["chatgpt/gpt-6.2-sol", "chatgpt/gpt-6.2-astra"]) {
    for (const stream of [false, true]) {
      const requests = [];
      // Astra reproduces the observed upstream response: usage contains reasoning but summary is empty.
      const summary = id.endsWith("sol");
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), "https://memory.example/test/v1/chat/completions");
        const body = JSON.parse(init.body); requests.push(body);
        assert.equal(body.model, id);
        assert.equal(new Headers(init.headers).get("x-aelios-session-id"), "fixture-session");
        if (requests.length === 2) assert.equal(body.messages.filter(message => message.role === "tool").length, 1);
        return answer(body.stream, requests.length === 1, summary);
      };
      const options = { model: aeliosModel(memory, id, { session: () => "fixture-session" }), prompt: "Run ping.", tools: { ping: tool({ inputSchema: jsonSchema({ type: "object", properties: { value: { type: "number" } }, required: ["value"] }), execute: async () => "pong" }) }, stopWhen: stepCountIs(2) };
      const result = stream ? streamText(options) : await generateText(options);
      const parts = []; const draft = new WebDraft("draft", 0, "web");
      if (stream) {
        // The same stream projections used for persisted UI messages and the live web draft.
        const live = (async () => { for await (const chunk of result.fullStream) draft.chunk(chunk); })();
        for await (const chunk of result.toUIMessageStream()) applyChunkToParts(parts, chunk);
        await live;
        assert.ok(requests.every(body => body.stream_options?.include_usage === true));
        const activity = activityOf(JSON.parse(JSON.stringify(parts)));
        assert.equal(activity.filter(part => part.type === "reasoning").map(part => part.text).join(""), summary ? reasoning + reasoning : "");
        assert.equal(activityOf(draft.parts).some(part => part.type === "reasoning"), summary);
      }
      assert.equal(await result.text, "OK");
      assert.equal(requests.length, 2);
      const steps = await result.steps;
      assert.equal(steps[0].reasoningText ?? "", summary ? reasoning : "");
      assert.equal((await result.totalUsage).outputTokenDetails.reasoningTokens, 60);
      assert.equal(steps[0].usage.inputTokenDetails.cacheReadTokens, 1024);
      assert.equal(steps[0].usage.raw.prompt_tokens_details.cache_write_tokens, 1536);
      const row = entryOf(steps[0], { kind: "chat", via: "web" }, 0, "1h");
      assert.deepEqual([row.input, row.cacheRead, row.cacheWrite, row.cacheWrite1h, row.reasoning], [440, 1024, 1536, 0, 30]);
      console.log(`PASS ${id} ${stream ? "stream" : "generate"}: summary, tool continuation, saved web activity, and token usage`);
    }
  }
  assert.equal(aeliosModel(memory, "openai/gpt-5").provider, "aelios.chat");
  console.log("PASS non-subscription model routing stays unchanged");
} finally { globalThis.fetch = realFetch; }
