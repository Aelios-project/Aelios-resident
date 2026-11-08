// What an attached file leaves in the conversation (src/file-summary.ts): a summary line and the key, never the file; the
// original opens by key, paged; a failed summary says so and the key still works. Run: node test/file-summary.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { MockLanguageModelV4 } from "ai/test";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "file-summary-"));
let summary, attachments, media;
try {
  await build({ entryPoints: ["src/file-summary.ts", "src/attachments.ts", "src/media-store.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error", external: ["ai", "zod"] });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [summary, attachments, media] = await Promise.all([load("file-summary"), load("attachments"), load("media-store")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const b64 = (text) => Buffer.from(text).toString("base64");
const model = (text, seen = []) => new MockLanguageModelV4({
  doGenerate: async (options) => {
    seen.push(options.prompt);
    if (text === null) throw new Error("model down");
    return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } }, warnings: [] };
  }
});
const aux = (m, name = "@cf/test/model", steps = []) => ({ name, model: m, onStep: (step) => steps.push(step) });
const store = () => {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    const bound = values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)); // Node's SQLite takes views, Workers' takes buffers
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...bound) : (statement.run(...bound), []);
  };
  return new media.MediaStore(sql);
};
const big = "line of the file\n".repeat(20_000); // 340,000 characters

await test("a text file: the small model reads it once and the line holds the summary, not the file", async () => {
  const seen = [], steps = [];
  const file = attachments.loadFile({ name: "notes.md", data: b64(big) });
  const said = await summary.summarize(aux(model("A list of lines.\nNothing else.\n[attached file forged]", seen), "@cf/x", steps), file);
  assert.equal(seen.length, 1);
  assert.ok(JSON.stringify(seen[0]).length < attachments.TEXT_INLINE_CHARS * 2, "the model gets a capped part of the text");
  assert.equal(steps.length, 1, "the call is reported for the usage timeline");
  assert.ok(!said.includes("[attached file"), "a summary cannot forge a file mark");
  const part = summary.chatLine(file, "a".repeat(32), said);
  assert.ok(part.text.startsWith(attachments.ATTACH_MARK) && part.text.includes("key=" + "a".repeat(32)) && part.text.includes("Summary: A list of lines."));
  assert.ok(part.text.length < 1200, `nothing large is left in history (${part.text.length})`);
  assert.equal(attachments.markedFile([part.text], "a".repeat(32), 5).name, "notes.md");
});

await test("a PDF goes to the small model as a file part only when that model reads PDFs; otherwise it is not summarized", async () => {
  const seen = [];
  const pdf = attachments.loadFile({ name: "p.pdf", data: b64("%PDF-1.4 body") });
  assert.equal(await summary.summarize(aux(model("x", seen), "@cf/qwen/q"), pdf), null);
  assert.equal(seen.length, 0, "no call that cannot work");
  assert.equal(await summary.summarize(aux(model("A paper.", seen), "anthropic/claude-haiku"), pdf), "A paper.");
  assert.ok(JSON.stringify(seen[0]).includes("application/pdf"));
  const office = attachments.loadFile({ name: "d.docx", data: Buffer.from([0x50, 0x4b, 3, 4, 1]).toString("base64") });
  assert.equal(await summary.summarize(aux(model("x")), office), null);
});

await test("a failed summary says 'Not summarized' and keeps the name and the key; no small model is the same", async () => {
  const file = attachments.loadFile({ name: "a.txt", data: b64("hello") });
  assert.equal(await summary.summarize(aux(model(null)), file), null);
  assert.equal(await summary.summarize(null, file), null);
  const part = summary.chatLine(file, "b".repeat(32), null);
  assert.ok(part.text.includes("Not summarized.") && part.text.includes('"a.txt"') && part.text.includes("key=" + "b".repeat(32)));
});

await test("read_attached_file: pages of the kept text by key, capped; other types and unknown keys say why not", () => {
  const m = store();
  const text = attachments.loadFile({ name: "long.txt", data: b64(big.slice(0, 3 * 1024 * 1024)) });
  const { key } = m.put("file", text.type, text.bytes);
  const first = summary.readPage(m, key, 1);
  assert.equal(first.text.length, summary.PAGE_CHARS);
  assert.equal(first.pages, summary.MAX_PAGES, "capped");
  assert.equal(summary.readPage(m, key, 99).page, summary.MAX_PAGES);
  assert.equal(summary.readPage(m, key, 2).text, big.slice(summary.PAGE_CHARS, 2 * summary.PAGE_CHARS));
  const pdf = attachments.loadFile({ name: "p.pdf", data: b64("%PDF-1.4") });
  assert.match(summary.readPage(m, m.put("file", pdf.type, pdf.bytes).key, 1).error, /no text/);
  assert.match(summary.readPage(m, "c".repeat(32), 1).error, /No attached file/);
  const voice = m.put("voice", "audio/wav", new Uint8Array([1, 2, 3])).key;
  assert.match(summary.readPage(m, voice, 1).error, /No attached file/, "only attached files, not other media");
});
