// Unit tests for http_request (src/web/http-request.ts), a thread's way to call an API, run in Node with every
// network call faked: keys go to their site only and never come back, pictures and sounds become files (a long
// base64 string in JSON too), redirects are checked hop by hop, a POST is not sent on along a redirect.
// Usage: node test/http-request.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-http-"));
await build({ entryPoints: ["src/web/http-request.ts"], bundle: true, packages: "external", platform: "node", format: "esm", outdir: dir, logLevel: "error" });
const { httpRequestTool, namer, sniff } = await import(pathToFileURL(join(process.cwd(), dir, "http-request.js")).href);
rmSync(dir, { recursive: true, force: true });

// --- The fake internet -----------------------------------------------------------------------------

const PUBLIC = "93.184.216.34";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(6000).fill(7)]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...new Array(100).fill(1)]);
// Little-endian samples, as Gemini sends them: 0x1234, 0x5678, then a ramp.
const PCM = new Uint8Array(6000).map((_, i) => [0x34, 0x12, 0x78, 0x56][i] ?? i % 256);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const SECRET = "sk-test-0123456789abcdef";
const KEYS = [
  { host: "api.example.com", headers: { Authorization: `Bearer ${SECRET}` } },
  { host: "gemini.example.com", headers: { "x-goog-api-key": "goog-key-123456" } }
];
let requests = [];

const routes = {
  "https://api.example.com/v1/echo": (request) => Response.json({ got: request.headers, body: request.body, note: `you sent ${SECRET}` }),
  "https://api.example.com/v1/image": () => new Response(PNG, { headers: { "content-type": "image/png" } }),
  "https://api.example.com/v1/speech": () => new Response(MP3, { headers: { "content-type": "application/octet-stream" } }),
  "https://api.example.com/v1/b64": () => Response.json({ data: [{ b64_json: b64(PNG) }, { b64_json: b64(PNG) }], usage: { tokens: 3 } }),
  "https://gemini.example.com/v1/tts": () =>
    Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: b64(PCM) } }] } }] }),
  "https://api.example.com/v1/l16": () => new Response(new Uint8Array([0x12, 0x34, 0x56, 0x78]), { headers: { "content-type": "audio/L16; rate=8000" } }),
  "https://gemini.example.com/v1/dataurl": () => Response.json({ image: `data:image/webp;base64,${b64(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(4000).fill(2)]))}` }),
  "https://api.example.com/v1/long": () => new Response("长".repeat(20_000), { headers: { "content-type": "text/plain; charset=utf-8" } }),
  "https://api.example.com/v1/huge": () => new Response(new Uint8Array(11 * 1024 * 1024), { headers: { "content-type": "video/mp4" } }),
  "https://api.example.com/v1/denied": () => Response.json({ error: `bad key ${SECRET}` }, { status: 401 }),
  "https://api.example.com/v1/empty": () => new Response(null, { status: 204 }),
  "https://api.example.com/v1/to-other": () => new Response(null, { status: 302, headers: { location: "https://other.example.org/landing" } }),
  "https://api.example.com/v1/to-local": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
  "https://api.example.com/v1/job": () => new Response(null, { status: 303, headers: { location: "/v1/job/7" } }),
  "https://api.example.com/v1/gated": () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } }),
  "https://other.example.org/landing": (request) => Response.json({ landed: true, headers: request.headers })
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
    const type = new URL(url).searchParams.get("type");
    return Response.json({ Answer: type === "A" ? [{ type: 1, data: PUBLIC }] : [] });
  }
  const headers = Object.fromEntries(new Headers(init.headers ?? {}));
  const request = { url, method: init.method ?? "GET", redirect: init.redirect, headers, body: init.body };
  requests.push(request);
  const route = routes[url];
  return route ? route(request) : new Response("not found", { status: 404 });
};

function files() {
  const saved = new Map();
  let refuse = null;
  const save = async (path, bytes) => {
    if (refuse) return refuse;
    saved.set(path, bytes);
    return null;
  };
  return { saved, save, refuseWith: (why) => (refuse = why) };
}

const run = (store, input, keys = KEYS) => httpRequestTool(keys, store.save).execute(input, { toolCallId: "t", messages: [] });
let failures = 0;
async function step(name, fn) {
  requests = [];
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

// --- The tests ---------------------------------------------------------------------------------------

await step("a POST carries the site's key and the body as JSON, and the key never comes back", async () => {
  const store = files();
  const out = await run(store, {
    method: "POST",
    url: "https://api.example.com/v1/echo",
    headers: { Authorization: "Bearer guessed", "X-Version": "2", Host: "evil.test", "Content-Length": "1" },
    body: '{"prompt":"一只猫"}'
  });
  const sent = requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, "the key wins over what the model wrote");
  assert.equal(sent.headers["x-version"], "2");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers.host, undefined, "the request's own headers are not the model's to set");
  assert.equal(sent.body, '{"prompt":"一只猫"}');
  assert.match(out, /^HTTP 200 · application\/json\n/);
  assert.ok(!out.includes(SECRET) && !out.includes("sk-test"), out);
  assert.match(out, /you sent \[key\]/);
  assert.equal(store.saved.size, 0);
});

await step("a site with no key gets none, and text that is not JSON goes as text", async () => {
  await run(files(), { method: "POST", url: "https://api.example.com/v1/echo", body: "hello" }, []);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers["content-type"], "text/plain; charset=utf-8");
});

await step("the description names the sites with keys", () => {
  assert.match(httpRequestTool(KEYS, files().save).description, /keys for api\.example\.com, gemini\.example\.com/);
  assert.match(httpRequestTool([], files().save).description, /no keys/);
});

await step("a picture becomes a file of the thread's, named by the time when unnamed", async () => {
  const store = files();
  const out = await run(store, { url: "https://api.example.com/v1/image" });
  const [[path, bytes]] = store.saved;
  assert.match(path, /^\/files\/\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
  assert.deepEqual(bytes, PNG);
  assert.match(out, new RegExp(`HTTP 200 · image/png\\nSaved as ${path} \\(5\\.9 KB, image/png\\)\\.`));
});

await step("a sound sent as octet-stream is known by its bytes, and save_as without an extension gets one", async () => {
  const store = files();
  const out = await run(store, { url: "https://api.example.com/v1/speech", save_as: "voice/hello" });
  assert.deepEqual([...store.saved.keys()], ["/voice/hello.mp3"]);
  assert.match(out, /Saved as \/voice\/hello\.mp3 .*audio\/mpeg/);
});

await step("base64 in a JSON answer is saved as files under save_as's name, and the answer names them", async () => {
  const store = files();
  const out = await run(store, { url: "https://api.example.com/v1/b64", save_as: "/cats/cat.png" });
  assert.deepEqual([...store.saved.keys()], ["/cats/cat.png", "/cats/cat-2.png"]);
  assert.deepEqual(store.saved.get("/cats/cat.png"), PNG);
  const body = JSON.parse(out.split("\n").slice(1).join("\n"));
  assert.match(body.data[0].b64_json, /^\[Saved as \/cats\/cat\.png/);
  assert.deepEqual(body.usage, { tokens: 3 }, "the rest of the answer stays");
  assert.ok(out.length < 1000, "no base64 reaches the model");
});

await step("Gemini's bare PCM speech is saved as a WAV that plays, and a data: URL by its type", async () => {
  const store = files();
  const out = await run(store, { method: "POST", url: "https://gemini.example.com/v1/tts", body: "{}" });
  assert.equal(requests[0].headers["x-goog-api-key"], "goog-key-123456");
  const [[path, wav]] = store.saved;
  assert.match(path, /\.wav$/);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString(), "WAVE");
  const view = new DataView(wav.buffer, wav.byteOffset);
  assert.equal(view.getUint32(24, true), 24000, "its rate");
  assert.equal(view.getUint32(40, true), PCM.length);
  assert.deepEqual(wav.subarray(44), PCM, "Gemini's samples are little-endian already: they go in as they are");
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true)], [0x1234, 0x5678], "so the values stay");
  assert.match(out, /audio\/wav/);

  // A bare audio/L16 (RFC 2586) is in network order: swapped into WAV's.
  const bare = files();
  await run(bare, { url: "https://api.example.com/v1/l16" });
  const plain = [...bare.saved.values()][0];
  assert.equal(new DataView(plain.buffer, plain.byteOffset).getUint32(24, true), 8000);
  assert.deepEqual([...plain.subarray(44)], [0x34, 0x12, 0x78, 0x56]);

  const webp = files();
  await run(webp, { url: "https://gemini.example.com/v1/dataurl" });
  assert.match([...webp.saved.keys()][0], /\.webp$/);
});

await step("a long text answer is cut, and kept whole as a file; save_as keeps a short one too", async () => {
  const store = files();
  const out = await run(store, { url: "https://api.example.com/v1/long" });
  assert.match(out, /\[cut off here\] Saved as \/files\/.*\.txt/);
  assert.ok(out.length < 13_000);
  assert.equal(new TextDecoder().decode([...store.saved.values()][0]).length, 20_000);

  const named = files();
  const echoed = await run(named, { url: "https://api.example.com/v1/echo", save_as: "/answers/echo.json" });
  assert.ok(!new TextDecoder().decode(named.saved.get("/answers/echo.json")).includes(SECRET), "the key is wiped from the file too");
  assert.match(echoed, /Saved as \/answers\/echo\.json/);
});

await step("an answer over 10 MB is not taken, and an empty one says so", async () => {
  const store = files();
  assert.match(await run(store, { url: "https://api.example.com/v1/huge" }), /over 10 MB/);
  assert.equal(store.saved.size, 0);
  assert.match(await run(store, { url: "https://api.example.com/v1/empty" }), /^HTTP 204\n\(an empty answer\)$/);
});

await step("a refused key is said, and an error's body comes back without the key", async () => {
  const out = await run(files(), { url: "https://api.example.com/v1/denied" });
  assert.match(out, /^HTTP 401 \(the site refused the key\)/);
  assert.match(out, /bad key \[key\]/);
});

await step("redirects: a GET follows them with the key looked up again, never to a private address; a POST stops", async () => {
  const out = await run(files(), { url: "https://api.example.com/v1/to-other" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.authorization, undefined, "the key stays with its site");
  assert.match(out, /landed/);

  assert.match(await run(files(), { url: "https://api.example.com/v1/to-local" }), /may not go/);
  requests = [];
  const posted = await run(files(), { method: "POST", url: "https://api.example.com/v1/job", body: "{}" });
  assert.equal(requests.length, 1, "not sent on");
  assert.match(posted, /HTTP 303: it points to https:\/\/api\.example\.com\/v1\/job\/7/);
  assert.match(await run(files(), { url: "https://api.example.com/v1/gated" }), /Cloudflare Access/);
});

await step("what cannot be asked: a private address, a GET with a body, a bad save_as", async () => {
  assert.match(await run(files(), { url: "http://127.0.0.1:8787/web/config" }), /^Cannot call this URL/);
  assert.match(await run(files(), { url: "https://api.example.com/v1/echo", body: "x" }), /GET has no body/);
  assert.match(await run(files(), { url: "https://api.example.com/v1/image", save_as: "../up.png" }), /save_as must be/);
  assert.match(await run(files(), { url: "https://api.example.com/v1/image", save_as: "/.agents/x.png" }), /save_as must be/);
  assert.equal(requests.length, 0, "nothing was sent");
});

await step("a file the thread may not keep says why", async () => {
  const store = files();
  store.refuseWith("at most 100 files and 50 MB per task");
  assert.match(await run(store, { url: "https://api.example.com/v1/image" }), /Not saved: at most 100 files/);
});

await step("names and types", () => {
  const named = namer("/a/b.mp3");
  assert.equal(named("wav"), "/a/b.mp3", "an extension they wrote stays");
  assert.equal(named("wav"), "/a/b-2.mp3");
  assert.equal(namer("a/../b"), null);
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f])), "video/mp4");
  assert.equal(sniff(new TextEncoder().encode('{"a":1}')), null);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
