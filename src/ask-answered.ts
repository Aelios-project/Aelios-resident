// A machine thread's open asks (res_machine_asks) leave the waiting list when the owner answers or dismisses them. The runner
// only resolves an ask in a later "done" receipt, so without this an answered ask stays listed until the turn ends well.
import type { Sql } from "./sticker-store";

/** Deletes the open asks of `thread` (only those of `task`, when given). Returns how many were open. */
export function clearAsks(sql: Sql, thread: string, task = ""): number {
  const open = task
    ? sql<{ key: string }>`SELECT key FROM res_machine_asks WHERE thread = ${thread} AND task_id = ${task}`
    : sql<{ key: string }>`SELECT key FROM res_machine_asks WHERE thread = ${thread}`;
  if (task) sql`DELETE FROM res_machine_asks WHERE thread = ${thread} AND task_id = ${task}`;
  else sql`DELETE FROM res_machine_asks WHERE thread = ${thread}`;
  return open.length;
}
