import type { WaitingItem } from "./waiting";

/** Live machine approvals projected into chat, without writing conversation messages. */
export function chatPermissions(items: WaitingItem[]): WaitingItem[] {
  return items.filter((item) => (item.kind === "permission" && Boolean(item.perm)) || (item.kind === "ask" && item.askKind === "permission"));
}
