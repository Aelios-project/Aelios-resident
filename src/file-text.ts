// PDFs and Office files as text, at send time, with Workers AI's Markdown conversion (env.AI.toMarkdown). The text is kept
// beside the file (media-store.ts) so the small model can summarize it and read_attached_file can page through it.
// Only the types the service reads are sent to it; images inside a document are not converted (they cost extra model calls).

import type { Loaded } from "./attachments";
import { MAX_PAGES, PAGE_CHARS } from "./file-summary";

/** Extensions the conversion service reads, among the types attachments.ts accepts (docs: Workers AI > Markdown conversion > Supported formats). */
const CONVERTIBLE = new Set(["pdf", "docx", "xlsx", "xls", "odt", "ods"]);
const CALL_TIMEOUT_MS = 30_000;
/** All a reader can page through (read_attached_file), so nothing more is kept. */
export const TEXT_KEEP_CHARS = MAX_PAGES * PAGE_CHARS;

export const convertible = (file: Loaded) => CONVERTIBLE.has(file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase());

/** The file's text, or null when it is not a type the service reads, there is no AI binding, or the conversion failed. Never throws. */
export async function toText(ai: Pick<Ai, "toMarkdown"> | undefined, file: Loaded): Promise<string | null> {
  if (!ai || !convertible(file)) return null;
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in time")), CALL_TIMEOUT_MS));
    const done = await Promise.race([
      ai.toMarkdown(
        { name: file.name, blob: new Blob([file.bytes as never], { type: file.type }) },
        { conversionOptions: { output: { format: "markdown" }, pdf: { images: { convert: false } }, docx: { images: { convert: false } } } }
      ),
      timeout
    ]);
    if (done.format === "error") {
      console.error("file text: conversion refused", { error: done.error });
      return null;
    }
    const text = done.data.replace(/\0/g, "").trim();
    return text ? text.slice(0, TEXT_KEEP_CHARS) : null;
  } catch (error) {
    console.error("file text: conversion failed", { error: String(error) });
    return null;
  }
}
