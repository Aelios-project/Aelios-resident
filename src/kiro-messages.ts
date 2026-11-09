// The conversation as the ACP box takes it (acp-box/prompt.mjs): each message as text by "User" or "You" with optional images,
// with a mark (a hash of the conversation up to it) so the box can tell what its live session already heard. Tool
// calls and their results are short lines of text: the helper only takes the calls it made itself back, and those
// arrive as `results`.

import { blocksOf, saidIn, sha256, type Block, type Message } from "./claude-code";
import { isNote } from "./prompts";

export type BoxImage = { type: "image"; data: string; mimeType: string };
export type BoxMessage = { who: "User" | "You"; text: string; mark: string; images?: BoxImage[] };

/** Pictures stay binary content, including a past tool result when a session must be seeded again. */
function imagesOf(content: unknown): BoxImage[] {
  return blocksOf(content).flatMap((block): BoxImage[] => {
    if (block.type === "tool_result") return imagesOf(block.content);
    if (block.type !== "image") return [];
    const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown } | undefined;
    if (source?.type !== "base64" || typeof source.data !== "string" || !source.data || typeof source.media_type !== "string" || !source.media_type.startsWith("image/")) {
      throw new Error("Kiro pictures require base64 image data and an image media type");
    }
    return [{ type: "image", data: source.data, mimeType: source.media_type }];
  });
}

const TOOL_TEXT_MAX = 4000;
const clip = (text: string) => (text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((block) => (block.type === "text" ? String(block.text ?? "") : block.type === "image" ? "[picture]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** One message as text; pictures and documents as short markers. */
export function textOf(message: Message): string {
  return blocksOf(message.content)
    .map((block: Block) => {
      switch (block.type) {
        case "text":
          return String(block.text ?? "");
        case "image":
          return "[picture]";
        case "document":
          return "[document]";
        case "tool_use":
          return clip(`[used the tool ${String(block.name ?? "")}: ${JSON.stringify(block.input ?? {})}]`);
        case "tool_result":
          return clip(`[the tool's result${block.is_error ? " (error)" : ""}]\n${resultText(block.content)}`);
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** The messages with their marks: each mark covers every message up to and including its own. */
export async function boxMessages(messages: Message[]): Promise<BoxMessage[]> {
  const out: BoxMessage[] = [];
  let mark = "";
  for (const message of messages) {
    const who = message.role === "assistant" ? "You" : "User";
    const text = textOf(message);
    const images = who === "User" ? imagesOf(message.content) : [];
    // Text-only marks stay compatible; changing only a picture must invalidate the live session too.
    const pictureMark = images.length ? `\n${await sha256(JSON.stringify(images))}` : "";
    mark = await sha256(`${mark}\n${who}\n${text}${pictureMark}`);
    out.push({ who, text, mark, ...(images.length ? { images } : {}) });
  }
  return out;
}

/** The tool_result blocks of the newest message when it is only results: the calls the reply before stopped at. */
export function resultsIn(last: Message | undefined): Block[] {
  const blocks = blocksOf(last?.content);
  if (!blocks.length || blocks.some((block) => block.type !== "tool_result")) return [];
  return blocks.map((block) => ({
    type: "tool_result",
    tool_use_id: String(block.tool_use_id ?? ""),
    content: typeof block.content === "string" ? [{ type: "text", text: block.content }] : blocksOf(block.content).map(({ cache_control: _c, ...part }) => part),
    ...(block.is_error ? { is_error: true } : {})
  }));
}

/**
 * Who said what this turn, for long-term memory: the user's own message that began the turn (not a note of the
 * system's), the reply's text before the calls it stopped at, and whether the turn goes on from tool results.
 */
export function turnOf(messages: Message[]): { said: string; before: string; hers: boolean; goesOn: boolean } {
  const goesOn = resultsIn(messages.at(-1)).length > 0;
  const start = messages.findLastIndex((message) => message.role === "user" && blocksOf(message.content).some((block) => block.type !== "tool_result"));
  const said = start < 0 ? "" : saidIn(messages[start].content);
  const before = goesOn ? messages.slice(start + 1).filter((message) => message.role === "assistant").map((message) => saidIn(message.content)).join("") : "";
  return { said, before, hers: Boolean(said) && !isNote(said.trimStart()), goesOn };
}
