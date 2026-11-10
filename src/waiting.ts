// The waiting list holds only what needs the owner's decision or action, in one fixed format (see the waiting-list spec in
// Aelios-desktop); when it is empty, nothing needs them. News (a thread finished, a note it left) is not on it: it is an
// unread count per thread, cleared by opening the thread. Computed when asked for, from asks, notes and each thread's
// newest task. It never writes into the conversation.
import type { AskKind } from "./machine-ask-kind";
export const ASK_EXPIRES_MS = 7 * 86_400_000;
export const ITEM_DROPPED_MS = 14 * 86_400_000;
const LINE_MAX = 120;

export type WaitingKind = "ask" | "note" | "done" | "stuck" | "permission";
/** What a stuck item asks of the owner: change a setting (a key, a login), or open the thread (a permission to give). */
export type WaitingAction = "" | "settings" | "open";
export type WaitingItem = {
  id: string;
  kind: WaitingKind;
  thread: string;
  /** The task an answer goes to. */
  task: string;
  title: string;
  line: string;
  options: string[];
  recommend: string;
  at: number;
  action: WaitingAction;
  /** A permission the machine holds: its id (the Allow / Deny buttons answer it) and the redacted command it asks to run. */
  perm?: string;
  detail?: string;
  /** Receipt ask subtype; distinct from a live held permission item. */
  askKind?: AskKind;
};

export type WaitingInput = {
  /** Open asks of threads on the machine. */
  asks: { kind?: AskKind; thread: string; task: string; key: string; question: string; options: string[]; recommend: string; at: number }[];
  /** Permissions the machine holds for the owner. */
  perms?: { id: string; thread: string; task: string; title: string; kind: string; detail: string; at: number }[];
  /** Notes a thread left with its last receipt. */
  notes: { thread: string; task: string; key: string; text: string; at: number }[];
  /** Each thread's newest task. */
  threads: { id: string; taskId: string; title: string; status: string; runs: string; summary: string; choices: string[]; reason: string; waiting: boolean; updatedAt: number }[];
  /** Ids of done and note items the owner has read, and of stuck items they put aside. */
  seen: ReadonlySet<string>;
  now: number;
};

// A bare "token" or "log in" is not enough: "Unexpected token" and "the log in /tmp" are not about a setting.
const NEEDS_SETTING =
  /\b(api[ _-]?keys?|(?:access|auth|bearer|github|api) tokens?|(?:missing|no|invalid|expired|revoked|bad) (?:api )?(?:tokens?|credentials?)|tokens? (?:is |was |has )?(?:missing|invalid|expired|revoked|required)|credentials?|sign(?:ed)?[ -]?in|not logged in|log[ -]?in (?:to|first|again|required)|login|unauthori[sz]ed|authenticat\w*)\b|密钥|登录|授权|令牌/i;
const NEEDS_PERMISSION = /\b(permission|not allowed|denied)\b|权限/i;

/** What the runner says the owner can do for each reason it gives (machine.ts FAIL_REASONS). The others are only the thread's status. */
// A refusal, a token limit or no result is a report to read, not a question: the owner opens the thread and decides.
const BY_REASON: Record<string, WaitingAction> = { needs_login: "settings", missing_key: "settings", permission_denied: "open", interrupted: "open", refused: "open", token_limit: "open", no_result: "open" };

/**
 * What the owner can do about a failed thread, if anything. A failure they can do nothing about is only the thread's
 * status. The runner's reason code decides; the keyword match on the text is the fallback for a result that has none
 * (rows from before the code existed, cloud tasks).
 */
export function stuckAction(summary: string, reason = ""): WaitingAction | null {
  if (reason) return BY_REASON[reason] ?? null;
  if (NEEDS_SETTING.test(summary)) return "settings";
  return NEEDS_PERMISSION.test(summary) ? "open" : null;
}

/** The first sentence of a text, as plain text, at most LINE_MAX characters. */
export function firstSentence(text: string): string {
  const flat = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?。！？](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > LINE_MAX ? `${sentence.slice(0, LINE_MAX - 1)}…` : sentence;
}

/** `items`: what needs the owner. `news`: done and note items not yet read (they count as unread on their thread). */
export function build({ asks, perms = [], notes, threads, seen, now }: WaitingInput): { items: WaitingItem[]; news: WaitingItem[] } {
  const title = new Map(threads.map((thread) => [thread.id, thread.title]));
  const items = new Map<string, WaitingItem>();
  const put = (item: WaitingItem) => {
    if (!item.line && item.kind === "ask") return; // a question with no words is not an ask
    const old = items.get(item.id);
    if (!old || old.at <= item.at) items.set(item.id, item);
  };
  const fresh = (at: number) => now - at <= ITEM_DROPPED_MS;
  for (const ask of asks) {
    if (!title.has(ask.thread) || now - ask.at > ASK_EXPIRES_MS) continue;
    put({ id: `${ask.thread}:ask:${ask.key}`, kind: "ask", thread: ask.thread, task: ask.task, title: title.get(ask.thread)!, line: firstSentence(ask.question),
      options: ask.options, recommend: ask.recommend, at: ask.at, action: "", ...(ask.kind ? { askKind: ask.kind } : {}) });
  }
  for (const perm of perms) {
    if (!title.has(perm.thread)) continue;
    put({ id: `${perm.thread}:perm:${perm.id}`, kind: "permission", thread: perm.thread, task: perm.task, title: title.get(perm.thread)!, line: perm.title, options: [], recommend: "", at: perm.at, action: "", perm: perm.id, detail: perm.detail });
  }
  for (const thread of threads) {
    const base = { thread: thread.id, task: thread.taskId, title: thread.title, options: [] as string[], recommend: "", at: thread.updatedAt, action: "" as WaitingAction };
    if (thread.waiting && thread.runs !== "machine") {
      if (now - thread.updatedAt > ASK_EXPIRES_MS) continue;
      put({ ...base, id: `${thread.id}:ask:${thread.taskId}`, kind: "ask", line: firstSentence(thread.summary), options: thread.choices });
    } else if (thread.status === "done") {
      put({ ...base, id: `${thread.id}:done:${thread.updatedAt}`, kind: "done", line: firstSentence(thread.summary) });
    } else if (thread.status === "failed") {
      const action = stuckAction(thread.summary, thread.reason);
      if (action !== null) put({ ...base, id: `${thread.id}:stuck:${thread.updatedAt}`, kind: "stuck", line: firstSentence(thread.summary), action });
    }
  }
  // A thread keeps its newest note only.
  const newest = new Map<string, (typeof notes)[number]>();
  for (const note of notes) if (!newest.has(note.thread) || newest.get(note.thread)!.at < note.at) newest.set(note.thread, note);
  for (const note of newest.values()) {
    if (!title.has(note.thread)) continue;
    put({ id: `${note.thread}:note:${note.key}`, kind: "note", thread: note.thread, task: note.task, title: title.get(note.thread)!, line: firstSentence(note.text), options: [], recommend: "", at: note.at, action: "" });
  }
  const live = [...items.values()].filter((item) => fresh(item.at));
  return {
    items: live.filter((item) => item.kind === "ask" || item.kind === "permission" || (item.kind === "stuck" && !seen.has(item.id))).sort((a, b) => Number(b.kind !== "stuck") - Number(a.kind !== "stuck") || b.at - a.at),
    news: live.filter((item) => (item.kind === "done" || item.kind === "note") && !seen.has(item.id))
  };
}

/** The push for a new ask: the thread's title and the question. */
export const askPush = (item: WaitingItem) => ({ body: `${item.title}: ${item.line}`.slice(0, 160), tag: item.kind === "permission" ? "permission" : "ask" });
