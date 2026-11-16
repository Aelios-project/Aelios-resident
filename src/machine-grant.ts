// A one-time pass for a held permission that ran out of time (PROTOCOL.md, "job.grant"). The runner holds a request
// for a short while only; when nobody answers, the turn ends asking for approval and the ask carries a grant id that
// only the runner can redeem. Her 允许 on that card sends the follow-up with the id, so the runner allows the same
// action once instead of holding it a second time. Nothing here is reachable from the model.
import type { Sql } from "./sticker-store";

export const GRANT = /^g_[0-9a-f]{10}$/;

/** What the follow-up says to the helper when she allows with a grant. It shows on the thread page as her words. */
export const GRANTED_TEXT = "允许。The owner allowed the action that was refused. Run the same action again, unchanged, and carry on.";

/** A grant is optional, and only an approval ask carries one. */
export function validGrant(value: unknown, kind: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && GRANT.test(value) && kind === "permission");
}

/** Columns added after the tables first shipped: the grant an ask offers, and the one a follow-up redeems. */
export function initGrant(sql: Sql): void {
  if (!sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('res_machine_asks') WHERE name = 'grant_id'`[0].n) {
    sql`ALTER TABLE res_machine_asks ADD COLUMN grant_id TEXT NOT NULL DEFAULT ''`;
  }
  if (!sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('res_machine_work') WHERE name = 'grant_id'`[0].n) {
    sql`ALTER TABLE res_machine_work ADD COLUMN grant_id TEXT NOT NULL DEFAULT ''`;
  }
}
