// One card per thread on the waiting list. A thread can be waiting in more than one way at the same time - its
// completed turn asked a question while the machine holds a permission for the owner - and the page shows a thread
// once, saying why it waits (a permission to give shows Allow / Deny, a question shows its options). Answers still
// go to what asked: a permission keeps its handle, a question keeps the task its answer belongs to.
import type { AskKind } from "./machine-ask-kind";
import type { WaitingItem } from "./waiting";

/**
 * Why the thread waits, told apart by what the owner has to do. `permission`: allow or deny it. `question`: answer
 * it. An ask whose kind the runner did not report keeps the old wording.
 */
export type WaitReason = "permission" | "question" | "ask";

export type MergedItem = WaitingItem & { reason?: WaitReason; reasons?: WaitReason[] };

const REASON_ORDER: Record<WaitReason, number> = { permission: 0, question: 1, ask: 2 };

/** The reason an ask waits for, from the kind the runner reported (machine-ask-kind.ts). */
export function askReason(askKind: AskKind | undefined): WaitReason {
  return askKind === "permission" ? "permission" : askKind === "question" ? "question" : "ask";
}

/** Asked for with Allow / Deny: a live permission, or an ask the runner typed as one. */
const isApproval = (item: WaitingItem) => item.kind === "permission" || (item.kind === "ask" && item.askKind === "permission");

const reasonOf = (item: WaitingItem): WaitReason | undefined =>
  isApproval(item) ? "permission" : item.kind === "ask" ? askReason(item.askKind) : undefined;

/**
 * The waiting list with one item per thread, every way of waiting folded together - an ask, a live permission, a
 * stuck failure. The card says what the owner has to do first (a permission comes first). The newest live permission
 * lends it its handle, title and detail, so Allow / Deny answers that exact request; a question keeps its own task and
 * options, so its answer goes to the task that asked it. An ask the runner typed as an approval has no handle: its
 * options are an answer through the task, never an Allow / Deny on an id that does not exist.
 */
export function mergeByThread(items: WaitingItem[]): MergedItem[] {
  const byThread = new Map<string, MergedItem[]>();
  for (const source of items) {
    // The stored sentence may be the old tier refusal; the card shows what it means today.
    const item: MergedItem = { ...source, line: currentWording(source.line), ...(source.detail ? { detail: currentWording(source.detail) } : {}) };
    const list = byThread.get(item.thread) ?? [];
    list.push({ ...item, reason: reasonOf(item) });
    byThread.set(item.thread, list);
  }
  const merged: MergedItem[] = [];
  for (const list of byThread.values()) {
    // A lone item is left exactly as it was, with its own kind and its own label.
    if (list.length === 1) { merged.push({ ...list[0], reason: list[0].kind === "ask" ? list[0].reason : undefined }); continue; }
    const byTime = [...list].sort((a, b) => b.at - a.at);
    const reasons = [...new Set(list.map((item) => item.reason).filter((reason): reason is WaitReason => Boolean(reason)))]
      .sort((a, b) => REASON_ORDER[a] - REASON_ORDER[b]);
    // Newest live permission first: deterministic, and its title and detail are what the buttons act on.
    const live = byTime.find((item) => item.kind === "permission");
    const typed = byTime.find((item) => item.kind === "ask" && item.askKind === "permission");
    const asked = byTime.find((item) => item.kind === "ask" && item.askKind !== "permission");
    // Where an answer goes: a question's options to the task that asked them, else a typed approval's own options.
    const answer = asked ?? typed ?? live ?? byTime[0];
    const shown = live ?? byTime.find((item) => item.line) ?? byTime[0];
    merged.push({ ...shown,
      id: `${byTime[0].thread}:waiting`,
      // The card's kind is the item that carries the buttons or the answer; the reasons say what to do.
      kind: live ? "permission" : byTime[0].kind,
      title: shown.title,
      line: shown.line || list.find((item) => item.line)?.line || "",
      at: byTime[0].at,
      options: answer.options,
      task: answer.task,
      recommend: answer.recommend,
      reason: reasons.length === 1 ? reasons[0] : undefined,
      reasons,
      ...(live?.perm ? { perm: live.perm } : { perm: undefined }),
      detail: shown.detail ?? list.find((item) => item.detail)?.detail });
  }
  return merged.sort((a, b) => Number(b.kind === "stuck") - Number(a.kind === "stuck") || b.at - a.at);
}

/** The threads that already have a card: the page shows no row of its own for these, or the thread would be twice. */
export function threadsOnCards(items: WaitingItem[]): string[] {
  return [...new Set(items.map((item) => item.thread))];
}

/**
 * A runner used to hold a request because the owner's tier did not allow it, and stored that sentence on the
 * receipt. The tier is gone: a helper asks, and the owner approves. Only that known obsolete phrasing is rewritten,
 * so an old item reads as what it now means; nothing else in anyone's words is touched.
 */
const OLD_TIER_REFUSAL = /\b(?:this machine'?s )?tier is read\b[^.!?]*/i;
const APPROVAL_WORDING = "The helper asked to do this and is waiting for your approval";

/** The line as shown for an item whose stored text still carries the old tier refusal. */
export function currentWording(line: string): string {
  return OLD_TIER_REFUSAL.test(line) ? line.replace(OLD_TIER_REFUSAL, APPROVAL_WORDING) : line;
}