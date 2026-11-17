// Real HTTP stalls with accelerated AbortSignal deadlines; no Telegram credentials or external network.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "resident-telegram-timeouts-"));
const out = join(dir, "telegram.mjs");
await build({ entryPoints: ["src/telegram.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const tg = await import(pathToFileURL(out).href);

let stall = null;
let requests = [];
const server = http.createServer((req, res) => {
  const method = req.url.split("/").at(-1);
  requests.push(method);
  req.resume();
  if (method === stall?.method) {
    if (stall.body) {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.write('{"ok":'); // Headers arrived, but the JSON body never finishes.
    }
    return;
  }
  res.writeHead(200, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ ok: true, result: true }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = { token: "synthetic-test-token", apiBase: `http://127.0.0.1:${server.address().port}` };
const connect = () => tg.setWebhook(config, "https://resident.example/messengers/telegram/webhook", "synthetic-secret", { miniAppUrl: "https://resident.example/" });
const originalTimeout = AbortSignal.timeout;
const deadlines = [];
AbortSignal.timeout = (ms) => {
  deadlines.push(ms);
  return originalTimeout(150);
};

async function test(name, fn) {
  requests = [];
  deadlines.length = 0;
  try {
    // A missing signal must fail the test instead of hanging the suite.
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Telegram operation did not settle")), 3000);
        timer.unref();
      })
    ]);
    assert.ok(deadlines.length > 0);
    assert.ok(deadlines.every((ms) => ms === 8000), "management calls use the existing eight-second deadline");
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack}`);
    process.exitCode = 1;
  } finally {
    stall = null;
  }
}

try {
  for (const method of ["setWebhook", "setMyCommands", "setChatMenuButton"]) {
    await test(`${method}: stalled response headers abort the connection attempt`, async () => {
      stall = { method, body: false };
      await assert.rejects(connect, (error) => error.name === "TimeoutError" || error.name === "AbortError");
      assert.equal(requests.at(-1), method, "later setup steps do not run after a failed request");
    });
    await test(`${method}: stalled response body also settles`, async () => {
      stall = { method, body: true };
      if (method === "setWebhook") {
        await assert.rejects(connect, (error) => error.name === "TimeoutError" || error.name === "AbortError");
        assert.deepEqual(requests, ["setWebhook"]);
      } else {
        // answer() preserves its existing structured failure for an unreadable JSON response.
        const result = await connect();
        assert.equal(result[method].ok, false);
      }
    });
  }
  await test("removing a token settles when deleting the old webhook stalls", async () => {
    stall = { method: "deleteWebhook", body: false };
    await tg.deleteWebhook(config);
    assert.deepEqual(requests, ["deleteWebhook"]);
  });
  await test("a later connection succeeds after the previous request timed out", async () => {
    const result = await connect();
    assert.equal(result.setWebhook.ok, true);
    assert.equal(result.setMyCommands.ok, true);
    assert.equal(result.setChatMenuButton.ok, true);
    assert.deepEqual(requests, ["setWebhook", "setMyCommands", "setChatMenuButton"]);
  });
  await test("non-HTTPS setup still configures commands without a Mini App button", async () => {
    const result = await tg.setWebhook(config, "http://resident.test/messengers/telegram/webhook", "synthetic-secret");
    assert.equal(result.setWebhook.ok, true);
    assert.equal(result.setMyCommands.ok, true);
    assert.equal(result.setChatMenuButton, undefined);
    assert.deepEqual(requests, ["setWebhook", "setMyCommands"]);
  });
} finally {
  AbortSignal.timeout = originalTimeout;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
