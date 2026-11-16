// Exercise the real model adapters and AI SDK tool loop without network calls.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { generateText, streamText, jsonSchema, stepCountIs, tool, convertToModelMessages } from "ai";
import { applyChunkToParts } from "agents/chat";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync("node_modules/.cache/gemini-signatures-");
const out = join(dir, "model.mjs");
await build({ entryPoints: ["src/via-aelios.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { aeliosModel } = await import(pathToFileURL(resolve(out)).href);
// This is the exact temporary directory created above.
rmSync(resolve(dir), { recursive: true, force: true });
const memory = { url: "https://memory.example", key: "fixture", namespace: "default", identity: "test" };
const signature = "opaque-original-signature+/=";
const calls = [0, 1, 2].map(index => ({ index, id: `call-${index}`, type: "function", function: { name: "ping", arguments: '{"value":' + index + '}' }, ...(index === 0 ? { extra_content: { google: { thought_signature: signature } } } : {}) }));
const chunk = (delta, finish_reason = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "gemini-fixture", choices: [{ index: 0, delta, finish_reason }] });
function answer(stream, tools, includeUsage) {
  if (!stream) return Response.json({ id: "fixture", object: "chat.completion", created: 0, model: "gemini-fixture", choices: [{ index: 0, message: { role: "assistant", content: tools ? null : "OK", ...(tools ? { tool_calls: calls.map(({ index, ...call }) => call) } : {}) }, finish_reason: tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  // Match Gemini's signed initial call delta, followed by streamed arguments.
  const chunks = tools ? [chunk({ role: "assistant", tool_calls: calls.map(call => ({ ...call, function: { name: call.function.name, arguments: "" } })) }), chunk({ tool_calls: calls.map(({ id, type, extra_content, ...call }) => ({ ...call, function: { arguments: call.function.arguments } })) }), chunk({}, "tool_calls")] : [chunk({ role: "assistant", content: "OK" }), chunk({}, "stop")];
  // Match providers that emit the final usage chunk only when requested.
  if (includeUsage) chunks.push({ ...chunk({}), choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } });
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const realFetch = globalThis.fetch;
try {
  for (const stream of [false, true]) {
    for (const id of ["google/gemini-4-hydrogen", "google-vertex-ai/gemini-4-hydrogen", "openrouter/google/gemini-4-hydrogen"]) {
      const requests = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        if (requests.length === 1) return answer(body.stream, true, body.stream_options?.include_usage);
        const sent = body.messages.find(message => message.role === "assistant" && message.tool_calls)?.tool_calls;
        assert.ok(sent, JSON.stringify({ roles: body.messages.map(m => m.role), requests: requests.length, body }));
        assert.equal(sent.length, 3);
        assert.equal(sent[0].extra_content.google.thought_signature, signature);
        assert.equal(sent[1].extra_content, undefined);
        assert.equal(sent[2].extra_content, undefined);
        assert.equal(body.messages.filter(message => message.role === "tool").length, 3);
        return answer(body.stream, false, body.stream_options?.include_usage);
      };
      const model = aeliosModel(memory, id);
      const options = { model, prompt: "Run all three pings.", tools: { ping: tool({ inputSchema: jsonSchema({ type: "object", properties: { value: { type: "number" } }, required: ["value"] }), execute: async ({ value }) => `pong ${value}` }) }, stopWhen: stepCountIs(2) };
      const result = stream ? streamText(options) : await generateText(options);
      const parts = [];
      if (stream) {
        // Think persists these UI parts through Agents' real message builder.
        for await (const chunk of result.toUIMessageStream()) applyChunkToParts(parts, chunk);
      }
      assert.equal(await result.text, "OK");
      assert.equal(requests.length, 2);
      if (stream) {
        assert.ok(requests.every(body => body.stream_options?.include_usage === true));
        const usage = await result.totalUsage;
        assert.equal(usage.inputTokens, 240);
        assert.equal(usage.outputTokens, 14);
      }
      const steps = await result.steps;
      // Round-trip persisted UI parts through the same conversion Think uses.
      const messages = stream
        ? await convertToModelMessages(JSON.parse(JSON.stringify([{ id: "saved", role: "assistant", parts }])))
        : JSON.parse(JSON.stringify(steps.flatMap(step => step.response.messages)));
      await generateText({ model, messages: [{ role: "user", content: "Run all three pings." }, ...messages, { role: "user", content: "Thanks" }] });
      assert.equal(requests.length, 3);
      console.log(`PASS ${stream ? "stream" : "generate"}: ${id}, parallel tools, saved metadata and continued reply`);
    }
  }
  assert.equal(aeliosModel(memory, "openai/gpt-5").provider, "aelios.chat");
  console.log("PASS other model adapters remain unchanged");
} finally { globalThis.fetch = realFetch; }
