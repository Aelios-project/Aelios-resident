// Unit tests for src/no-model.ts: with no Aelios and no box a chat model fails with one clear line, and a saved
// `custom/…` choice is recognised as removed. Usage: node test/no-model.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-no-model-"));
const out = join(dir, "no-model.mjs");
await build({ entryPoints: ["src/no-model.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { NO_MODEL, isRemovedModel, noModel } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

assert.equal(isRemovedModel("custom/nous/claude-test"), true);
for (const id of ["claude-code/claude-opus-5-5", "kiro/auto", "anthropic/claude-opus-5-5", "@cf/zai-org/glm-4.7-flash", "custom-nous/hermes"]) {
  assert.equal(isRemovedModel(id), false, id);
}
assert.match(NO_MODEL, /Aelios/);
assert.equal(NO_MODEL.includes("\n"), false, "one line");
await assert.rejects(() => noModel().doGenerate({ prompt: [] }), { message: NO_MODEL });
await assert.rejects(() => noModel().doStream({ prompt: [] }), { message: NO_MODEL });
console.log("PASS no-model: removed ids recognised, calls fail with one line");
