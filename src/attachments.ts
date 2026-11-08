// Files and pictures the user attaches on the web page, in the chat (webSay) and in a thread (webThreadSay). The server
// decides everything: the type comes from the name's extension AND the bytes, the name is cleaned here, the size is
// capped. Nothing a client says about a file is believed. Kept files live in the media store (media-store.ts).

import type { UIMessage } from "ai";
import type { MediaStore } from "./media-store";
import { sniff } from "./stickers";

/** What a thread is handed: enough to fetch the bytes (by key) and to show them. */
export type Attachment = { key: string; name: string; type: string; size: number };
export type AttachInput = { name?: unknown; data?: unknown };
export type Loaded = { name: string; type: string; bytes: Uint8Array; kind: "pdf" | "text" | "other" | "image"; text?: string };

export const ATTACH_MAX_FILES = 3;
export const ATTACH_MAX_PICTURES = 4;
export const ATTACH_MAX_BYTES = 4 * 1024 * 1024;
/** How much of a text file goes into the conversation itself; the rest stays in the kept copy. */
export const TEXT_INLINE_CHARS = 30_000;
/** Opens every text part that carries a file, so the web page can leave it out of the message bubble. */
export const ATTACH_MARK = "[attached file ";

const TEXT_EXT = ("txt md markdown csv tsv json jsonl xml yaml yml toml ini cfg conf env log html htm css scss js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql lua r tex srt diff patch").split(" ");
const OFFICE_EXT: Record<string, { type: string; magic: number[] }> = {
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b, 3, 4] },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [0x50, 0x4b, 3, 4] },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: [0x50, 0x4b, 3, 4] },
  odt: { type: "application/vnd.oasis.opendocument.text", magic: [0x50, 0x4b, 3, 4] },
  ods: { type: "application/vnd.oasis.opendocument.spreadsheet", magic: [0x50, 0x4b, 3, 4] },
  odp: { type: "application/vnd.oasis.opendocument.presentation", magic: [0x50, 0x4b, 3, 4] },
  doc: { type: "application/msword", magic: [0xd0, 0xcf, 0x11, 0xe0] },
  xls: { type: "application/vnd.ms-excel", magic: [0xd0, 0xcf, 0x11, 0xe0] },
  ppt: { type: "application/vnd.ms-powerpoint", magic: [0xd0, 0xcf, 0x11, 0xe0] },
  rtf: { type: "application/rtf", magic: [0x7b, 0x5c, 0x72, 0x74] }
};
const PICTURE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** A name that is safe on any disk: no folders, no control characters, no leading dot, at most 80 characters, the extension kept. */
export function safeName(name: unknown): string {
  const last = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = last.replace(/[^\p{L}\p{N}._ ()-]/gu, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? clean.slice(dot).slice(0, 12) : "";
  const base = (dot > 0 ? clean.slice(0, dot) : clean).slice(0, 80 - ext.length);
  return base ? base + ext : "file";
}

const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

function decode(data: unknown): Uint8Array | { error: string } {
  const text = String(data ?? "");
  if (text.length > Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 8) return { error: `文件太大了，最多 ${ATTACH_MAX_BYTES / 1024 / 1024} MB` };
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    if (!bytes.length) return { error: "空的文件" };
    return bytes.length > ATTACH_MAX_BYTES ? { error: `文件太大了，最多 ${ATTACH_MAX_BYTES / 1024 / 1024} MB` } : bytes;
  } catch {
    return { error: "文件没传完整，再发一次" };
  }
}

/** A file that is not a picture: a PDF, text or code, or an office document. Anything else is refused. */
export function loadFile(input: AttachInput): Loaded | { error: string } {
  const name = safeName(input.name);
  const bytes = decode(input.data);
  if ("error" in bytes) return bytes;
  const ext = extOf(name);
  if (ext === "pdf") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    return head.includes("%PDF-") ? { name, type: "application/pdf", bytes, kind: "pdf" } : { error: `「${name}」不是有效的 PDF` };
  }
  const office = OFFICE_EXT[ext];
  if (office) {
    return office.magic.every((byte, at) => bytes[at] === byte) ? { name, type: office.type, bytes, kind: "other" } : { error: `「${name}」的内容和它的类型对不上` };
  }
  if (TEXT_EXT.includes(ext)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      if (!text.includes("\0")) return { name, type: "text/plain", bytes, kind: "text", text };
    } catch {
      /* not UTF-8 text */
    }
    return { error: `「${name}」读不出文字` };
  }
  return { error: `「${name}」这种文件暂时收不了（可以发 PDF、文本、代码、Word/Excel/PowerPoint）` };
}

/** A picture for a thread: JPEG, PNG, WebP or GIF by its bytes. It gets a name of the server's own making. */
export function loadPicture(input: AttachInput, n: number): Loaded | { error: string } {
  const bytes = decode(input.data);
  if ("error" in bytes) return bytes;
  const type = sniff(bytes) ?? "";
  const ext = PICTURE_EXT[type];
  return ext ? { name: `picture-${n + 1}.${ext}`, type, bytes, kind: "image" } : { error: "这不是一张能看的图片（要 JPEG、PNG、WebP 或 GIF）" };
}

/** Keeps what was loaded in the media store. */
export function keep(media: MediaStore, loaded: Loaded[]): Attachment[] | { error: string } {
  const kept: Attachment[] = [];
  for (const item of loaded) {
    const saved = media.put(item.kind === "image" ? "picture" : "file", item.type, item.bytes);
    if ("error" in saved) {
      for (const done of kept) media.remove(done.key);
      return saved;
    }
    kept.push({ key: saved.key, name: item.name, type: item.type, size: item.bytes.length });
  }
  return kept;
}

/** Loads a thread's pictures and files, or says what is wrong with them. */
export function loadAll(pictures: unknown, files: unknown): Loaded[] | { error: string } {
  const pics = Array.isArray(pictures) ? pictures : [];
  const docs = Array.isArray(files) ? files : [];
  if (pics.length > ATTACH_MAX_PICTURES) return { error: `一次最多 ${ATTACH_MAX_PICTURES} 张图` };
  if (docs.length > ATTACH_MAX_FILES) return { error: `一次最多 ${ATTACH_MAX_FILES} 个文件` };
  const loaded: Loaded[] = [];
  for (const [n, pic] of pics.entries()) {
    const one = loadPicture((pic ?? {}) as AttachInput, n);
    if ("error" in one) return one;
    loaded.push(one);
  }
  for (const doc of docs) {
    const one = loadFile((doc ?? {}) as AttachInput);
    if ("error" in one) return one;
    loaded.push(one);
  }
  return loaded;
}

/** Whether the chat's model takes a PDF as a file part. The gateway's big models do; Workers AI, a custom relay and the Claude box are not assumed to. */
export const readsPdf = (model: string) => !/^(@cf\/|custom\/|claude-code\/|fake$)/.test(model);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * What the model gets for a file in the chat: a text part naming it (with the key, so it can be handed to a thread),
 * plus the PDF as a file part, or the text as text, or for any other type a line saying it is kept.
 * shortcut: a PDF stays in the conversation as base64 like a picture does, up to 4 MB; trim old ones if the history gets heavy.
 */
export function chatParts(loaded: Loaded, key: string, pdfOk: boolean): UIMessage["parts"] {
  const head = `${ATTACH_MARK}"${loaded.name}" (${loaded.type}, ${Math.max(1, Math.round(loaded.bytes.length / 1024))} KB) key=${key}]`;
  if (loaded.kind === "text") {
    const text = loaded.text ?? "";
    const cut = text.length > TEXT_INLINE_CHARS ? `${text.slice(0, TEXT_INLINE_CHARS)}\n…(cut; the whole file is kept)` : text;
    return [{ type: "text", text: `${head}\n<<<\n${cut.replace(/<<<|>>>/g, "")}\n>>>` }];
  }
  if (loaded.kind === "pdf" && pdfOk) {
    return [{ type: "text", text: head }, { type: "file", mediaType: loaded.type, filename: loaded.name, url: `data:${loaded.type};base64,${base64(loaded.bytes)}` }];
  }
  const why = loaded.kind === "pdf" ? "this model cannot read PDFs" : "you cannot read this type";
  return [{ type: "text", text: `${head}\n(Kept, but ${why}. A thread on their machine can open it: hand it over with this key.)` }];
}

/** A file the user attached in the chat, found by its key in the messages' text: its name and type come from the mark written then, never from the model. */
export function markedFile(texts: readonly string[], key: string, size: number): Attachment | null {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  for (const text of texts) {
    const found = text.match(new RegExp(`\\[attached file "([^"\\n]{1,80})" \\(([^,)]{1,120}), \\d+ KB\\) key=${key}\\]`));
    if (found) return { key, name: found[1], type: found[2], size };
  }
  return null;
}
