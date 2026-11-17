// http_request: a thread of the resident's (cloud-tasks.ts) calls an API the way it would with curl, a GET or a POST
// with a body. Only threads get it, and only when 「线程能调 API」 (CLOUD_TASK_HTTP) is on: the chat itself never does.
//
// - A site with a key on the settings page (site-keys.ts) gets it as web_fetch gives it: over https, to that site
//   only, looked up again at every redirect. The model never sees it, and it is wiped from what comes back.
// - An answer that is not text (a picture, a voice, a video) is saved as a file of the thread's, and so is a long
//   run of base64 in a JSON answer (an image API's b64_json, Gemini's inlineData): the model gets the file's name.
// - Private and local addresses are refused at every step.

import { tool } from "ai";
import { z } from "zod";
import { headersFor, isAccessSignIn, type SiteKey } from "./site-keys";
import { validateUrlWithDns } from "./validate-url";

// The size a thread's file may be (task-worker.ts THREAD_FILE_MAX), so the size of an answer.
const MAX_BYTES = 10 * 1024 * 1024;
// What the model gets back of a text answer at most.
const MAX_CHARS = 12_000;
// A string this long in a JSON answer that is all base64 is a file, not words.
const BASE64_MIN = 4096;
const FILES_PER_ANSWER = 8;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 120_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Headers that belong to the request itself; anything else the API asks for they may set.
const OWN_HEADERS = /^(host|content-length|connection|transfer-encoding|upgrade|te|trailer|keep-alive|expect|proxy-.*)$/i;

/** Keeps a file among the thread's; an error message when it cannot. */
export type SaveFile = (path: string, bytes: Uint8Array) => Promise<string | null>;

export const HTTP_REQUEST_DESCRIPTION =
  "Call a web API, as you would with curl: a GET, or a POST with a body. Use it for APIs that make pictures, speech " +
  "or video, or any other JSON API. A picture, sound or video that comes back is saved as one of your files (so is a " +
  "long base64 string in a JSON answer), and you get its name: name the file in your report. Text comes back as it is.";

export function httpRequestTool(keys: readonly SiteKey[], save: SaveFile) {
  const keyed = keys.map((key) => key.host);
  return tool({
    description:
      HTTP_REQUEST_DESCRIPTION +
      (keyed.length ? ` They gave you keys for ${keyed.join(", ")}: requests there carry them, so leave the key out.` : " They gave you no keys for any site."),
    inputSchema: z.object({
      method: z.enum(["GET", "POST"]).optional().describe("GET unless you send a body."),
      url: z.string().describe("The full https URL."),
      headers: z.record(z.string(), z.string()).optional().describe("Headers the API needs besides its key, such as a version header."),
      body: z.string().optional().describe("With POST: the body, usually JSON text (sent as application/json unless headers say otherwise)."),
      save_as: z.string().optional().describe("A path for the file, such as /voice/hello.mp3. Optional: one is picked for you.")
    }),
    execute: async ({ method = "GET", url, headers, body, save_as }) => {
      if (method === "GET" && body) return "A GET has no body: use POST.";
      const check = await validateUrlWithDns(url);
      if (!check.valid) return `Cannot call this URL: ${check.error}`;
      const name = namer(save_as);
      if (save_as && !name) return "save_as must be a plain path such as /voice/hello.mp3, without .. or hidden folders.";
      try {
        return await call({ method, url, headers: headers ?? {}, body, keys, save, name: name!, asked: Boolean(save_as?.trim()) });
      } catch (error) {
        return `The request failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
}

type Call = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  keys: readonly SiteKey[];
  save: SaveFile;
  name: (ext: string) => string;
  /** Whether they named the file: a text answer is then saved too. */
  asked: boolean;
};

async function call({ method, url, headers, body, keys, save, name, asked }: Call): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const dns = new Map<string, Promise<string[]>>();
  let current = url;
  let key = headersFor(keys, current);
  let response: Response;
  for (let hop = 0; ; hop++) {
    response = await fetch(current, { method, headers: requestHeaders(headers, key, body), body: method === "POST" ? (body ?? "") : undefined, redirect: "manual", signal });
    const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
    if (!location) break;
    await response.body?.cancel();
    const next = new URL(location, current).toString();
    if (isAccessSignIn(next)) {
      const host = new URL(current).host;
      return key
        ? `${host} is behind Cloudflare Access and did not let the key in.`
        : `${host} is behind Cloudflare Access; they can add a key for ${host} on the settings page.`;
    }
    // A POST is not sent on along a redirect: the model decides what to do with where it points.
    if (method === "POST") return `HTTP ${response.status}: it points to ${next}. If the result is there, GET it.`;
    if (hop === MAX_REDIRECTS) return `It redirected more than ${MAX_REDIRECTS} times.`;
    const checked = await validateUrlWithDns(next, dns);
    if (!checked.valid) return `It redirected somewhere it may not go: ${checked.error}`;
    current = next;
    key = headersFor(keys, current);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const refused = key && (response.status === 401 || response.status === 403) ? " (the site refused the key)" : "";
  const head = `HTTP ${response.status}${refused}${type ? ` · ${type.split(";")[0]}` : ""}`;
  const bytes = await readAll(response);
  if (!bytes) return `${head}\nThe answer is over ${MAX_BYTES / 1024 / 1024} MB: ask for a smaller one.`;
  if (!bytes.length) return `${head}\n(an empty answer)`;
  const sniffed = sniff(bytes);
  if (sniffed || !isText(type, bytes)) {
    const file = await saveBytes(save, name, bytes, sniffed ?? type);
    return `${head}\n${file}`;
  }
  let text = scrub(new TextDecoder().decode(bytes), secretsOf(keys));
  // A JSON answer with files in it: each one saved under the answer's names, and its name in its place.
  const pulled = { saved: [] as string[], left: FILES_PER_ANSWER };
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      const value = await pullFiles(JSON.parse(text), save, name, pulled);
      if (pulled.saved.length) text = JSON.stringify(value);
    } catch {
      // Not JSON after all: it goes as text.
    }
  }
  const short = text.length <= MAX_CHARS;
  if (short && !(asked && !pulled.saved.length)) return `${head}\n${text}`;
  // The whole text as a file: where they asked, or (past the files it held, or unasked) a name of its own.
  const path = asked && !pulled.saved.length ? name("txt") : namer(undefined)!("txt");
  const whole = new TextEncoder().encode(text);
  const problem = await save(path, whole);
  const kept = problem ? `Not saved: ${problem}` : `Saved as ${path} (${size(whole.length)}).`;
  return short ? `${head}\n${text}\n\n${kept}` : `${head}\n${text.slice(0, MAX_CHARS)}\n\n[cut off here] ${kept}`;
}

function requestHeaders(own: Record<string, string>, key: Record<string, string> | null, body: string | undefined): Headers {
  const headers = new Headers({ "user-agent": "aelios-resident", accept: "*/*" });
  for (const [name, value] of Object.entries(own)) if (!OWN_HEADERS.test(name)) headers.set(name, value);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", looksJson(body) ? "application/json" : "text/plain; charset=utf-8");
  // The key wins over anything the model wrote under the same name.
  for (const [name, value] of Object.entries(key ?? {})) headers.set(name, value);
  return headers;
}

function looksJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The whole body, or null when it is over MAX_BYTES. */
async function readAll(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function isText(type: string, bytes: Uint8Array): boolean {
  if (/^text\/|json|xml|javascript|x-www-form-urlencoded/.test(type)) return true;
  if (type && type !== "application/octet-stream") return false;
  try {
    return !new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).includes("\u0000");
  } catch {
    return false;
  }
}

// ---- files ----

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/zip": "zip"
};

/** A file's type from its first bytes, for the common pictures, sounds and videos; null when it is none of them. */
export function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes.length > 3)) return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 8) === "ftyp") return ascii(8, 11) === "M4A" ? "audio/mp4" : "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  return null;
}

/**
 * Where the answer's files go: save_as (the next one with -2, -3 before the extension), or /files/ with the time.
 * Null when save_as is not a plain path.
 */
export function namer(saveAs: string | undefined): ((ext: string) => string) | null {
  let count = 0;
  if (!saveAs?.trim()) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const tag = crypto.randomUUID().slice(0, 4);
    return (ext) => `/files/${stamp}-${tag}${++count > 1 ? `-${count}` : ""}.${ext}`;
  }
  const path = saveAs.trim().replace(/^\/+/, "");
  const parts = path.split("/");
  if (path.length > 200 || /[\\\u0000-\u001f\u007f]/.test(path) || parts.some((part) => !part || part.startsWith("."))) return null;
  const dot = /\.[A-Za-z0-9]{1,8}$/.exec(path);
  return (ext) => {
    const stem = dot ? path.slice(0, dot.index) : path;
    const own = dot ? dot[0] : `.${ext}`;
    return `/${stem}${++count > 1 ? `-${count}` : ""}${own}`;
  };
}

/** Saves the bytes under the next name; what to tell the model. */
async function saveBytes(save: SaveFile, name: (ext: string) => string, bytes: Uint8Array, type: string): Promise<string> {
  const wav = pcmAsWav(bytes, type);
  const kept = wav ?? bytes;
  const bare = (wav ? "audio/wav" : type).split(";")[0].trim();
  const path = name(EXTENSIONS[bare] ?? "bin");
  const problem = await save(path, kept);
  return problem ? `Not saved: ${problem}` : `Saved as ${path} (${size(kept.length)}${bare ? `, ${bare}` : ""}).`;
}

/**
 * Bare 16-bit PCM put in a WAV, so it plays; null for anything else. Gemini's speech says
 * audio/L16;codec=pcm;rate=24000 but is little-endian, as WAV is: it goes in as it is. Only a bare audio/L16 (RFC
 * 2586, network order) is swapped.
 */
function pcmAsWav(bytes: Uint8Array, type: string): Uint8Array | null {
  if (!/^audio\/(l16|pcm)\b/i.test(type)) return null;
  const rate = Number(/rate=(\d+)/i.exec(type)?.[1] ?? 24000);
  const channels = Number(/channels=(\d+)/i.exec(type)?.[1] ?? 1);
  const wav = new Uint8Array(44 + bytes.length);
  const view = new DataView(wav.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length, true);
  const big = /^audio\/l16/i.test(type) && !/codec=pcm/i.test(type);
  if (!big) wav.set(bytes, 44);
  else for (let i = 0; i + 1 < bytes.length; i += 2) [wav[44 + i], wav[45 + i]] = [bytes[i + 1], bytes[i]];
  return wav;
}

/** The JSON value with every long base64 string saved as a file and its place taken by the file's name. */
async function pullFiles(value: unknown, save: SaveFile, name: (ext: string) => string, pulled: { saved: string[]; left: number }, siblings?: Record<string, unknown>): Promise<unknown> {
  if (typeof value === "string") {
    const file = base64File(value, siblings);
    if (!file) return value;
    if (pulled.left <= 0) return `[base64, ${value.length} characters, not saved: too many files in one answer]`;
    pulled.left -= 1;
    const said = await saveBytes(save, name, file.bytes, file.type);
    pulled.saved.push(said);
    return `[${said}]`;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await pullFiles(item, save, name, pulled));
    return out;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(object)) out[field] = await pullFiles(item, save, name, pulled, object);
    return out;
  }
  return value;
}

/** A long base64 string's bytes and type (from a data: URL, a mimeType beside it, or the bytes); null for words. */
function base64File(text: string, siblings?: Record<string, unknown>): { bytes: Uint8Array; type: string } | null {
  if (text.length < BASE64_MIN) return null;
  const data = /^data:([\w.+-]+\/[\w.+-]+(?:;[\w=.-]+)*?);base64,/i.exec(text);
  const raw = (data ? text.slice(data[0].length) : text).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  const beside = siblings && [siblings.mimeType, siblings.mime_type, siblings.media_type, siblings.content_type].find((type) => typeof type === "string");
  return { bytes, type: data?.[1] ?? (beside as string | undefined) ?? sniff(bytes) ?? "" };
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---- keys never come back ----

/** Every key's values (and a Bearer token without its word), longest first, to wipe from answers. */
function secretsOf(keys: readonly SiteKey[]): string[] {
  const found = new Set<string>();
  for (const key of keys) {
    for (const value of Object.values(key.headers)) {
      for (const secret of [value, value.replace(/^bearer\s+/i, "")]) if (secret.length >= 8) found.add(secret);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join("[key]"), text);
}
