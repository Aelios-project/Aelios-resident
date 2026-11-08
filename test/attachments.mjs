// What the web page may attach (src/attachments.ts): type by name AND bytes, clean names, size cap, parts for the model.
// Run: node test/attachments.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "attachments-"));
let a;
try {
  await build({ entryPoints: ["src/attachments.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  a = await import(pathToFileURL(join(dir, "attachments.mjs")).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

await test("names are cleaned: no folders, no dot-leading, no odd characters", () => {
  assert.equal(a.safeName("../../etc/passwd"), "passwd");
  assert.equal(a.safeName("C:\\Users\\me\\report final.pdf"), "report final.pdf");
  assert.equal(a.safeName(".bashrc"), "bashrc");
  assert.equal(a.safeName("a\u0000b<c>.txt"), "a_b_c_.txt");
  assert.equal(a.safeName(""), "file");
  assert.ok(a.safeName("x".repeat(200) + ".md").length <= 80);
});

await test("a file is accepted by its name and its bytes together", () => {
  assert.equal(a.loadFile({ name: "a.pdf", data: b64("%PDF-1.7 body") }).kind, "pdf");
  assert.ok("error" in a.loadFile({ name: "a.pdf", data: b64("MZ not a pdf") }));
  assert.equal(a.loadFile({ name: "main.py", data: b64("print(1)\n") }).kind, "text");
  assert.ok("error" in a.loadFile({ name: "bin.txt", data: b64(new Uint8Array([0, 1, 2, 255, 254])) }), "binary posing as text");
  assert.equal(a.loadFile({ name: "d.docx", data: b64(new Uint8Array([0x50, 0x4b, 3, 4, 9])) }).kind, "other");
  assert.ok("error" in a.loadFile({ name: "d.docx", data: b64("plain") }));
  assert.ok("error" in a.loadFile({ name: "run.exe", data: b64("MZ") }), "types off the list are refused");
  assert.ok("error" in a.loadFile({ name: "a.txt", data: "!!!not base64" }));
  assert.ok("error" in a.loadFile({ name: "a.txt", data: b64(new Uint8Array(a.ATTACH_MAX_BYTES + 1).fill(65)) }), "too big");
});

await test("a thread's pictures are judged by their bytes and named by the server", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const ok = a.loadPicture({ name: "../evil.sh", data: b64(png) }, 0);
  assert.equal(ok.name, "picture-1.png");
  assert.ok("error" in a.loadPicture({ data: b64("<svg/>") }, 0));
  assert.ok("error" in a.loadAll(Array(5).fill({ data: b64(png) }), []), "at most 4 pictures");
  assert.ok("error" in a.loadAll([], Array(4).fill({ name: "a.txt", data: b64("x") })), "at most 3 files");
});

await test("chat parts: text goes in as text with its key, a PDF as a file part only when the model reads PDFs", () => {
  const key = "c".repeat(32);
  const text = a.loadFile({ name: "n.md", data: b64("hello") });
  const [part] = a.chatParts(text, key, true);
  assert.ok(part.text.startsWith(a.ATTACH_MARK) && part.text.includes("hello") && part.text.includes(`key=${key}`));
  assert.equal(a.markedFile([part.text], key, 5).name, "n.md");
  assert.equal(a.markedFile([part.text], "d".repeat(32), 5), null);
  const pdf = a.loadFile({ name: "p.pdf", data: b64("%PDF-1.4") });
  assert.equal(a.chatParts(pdf, key, true).length, 2);
  assert.equal(a.chatParts(pdf, key, false).length, 1);
  assert.equal(a.readsPdf("@cf/zai-org/glm-4.7-flash"), false);
  assert.equal(a.readsPdf("anthropic/claude-sonnet-4-5"), true);
});
