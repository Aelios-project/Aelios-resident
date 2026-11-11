// Permissions the runner holds for the owner (PROTOCOL.md, "permission"). The runner reports one when a helper asks
// instead of approving it itself, the waiting list shows it with Allow / Deny, and only the owner's button answers
// it: nothing here is reachable from the model. The answer goes back in the runner's next poll; the runner closes the
// request when it is settled anywhere (here, on the desktop, timeout, stopped turn).
import type { Sql } from "./sticker-store";

/** The runner holds a request for 10 minutes, then counts it as denied; the item leaves a little after. */
export const PERM_HOLD_MS = 10 * 60_000;
const SLACK_MS = 60_000;
const ID = /^p_[0-9a-f]{10}$/;
const KIND = /^[a-z_]{1,20}$/;
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim().slice(0, max) : "");

export type Perm = { id: string; thread: string; task: string; title: string; kind: string; detail: string; at: number };
export type PermReport = { workId: string; token: string; id: string } & ({ state: "closed" } | { state: "held"; title: string; kind: string; detail: string });

/** A strict permission report from the runner, or the reason it is not one. */
export function parsePermReport(body: Record<string, unknown>): PermReport | string {
  const { workId, token, id, state } = body;
  const allowed = state === "held" ? ["workId", "token", "id", "state", "title", "kind", "detail"] : ["workId", "token", "id", "state"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return "the permission report has a field the protocol does not name";
  if (typeof workId !== "string" || typeof token !== "string" || typeof id !== "string" || !ID.test(id)) return "workId, token or id is not valid";
  const base = { workId, token, id };
  if (state === "closed") return { ...base, state };
  if (state !== "held") return "state is held or closed";
  const title = clean(body.title, 120);
  if (!title || typeof body.kind !== "string" || !KIND.test(body.kind)) return "a held permission needs a title and a kind";
  return { ...base, state, title, kind: body.kind, detail: clean(body.detail, 400) };
}

export class PermStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_machine_perms (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, thread TEXT NOT NULL, task_id TEXT NOT NULL,
      title TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL, answer INTEGER)`;
  }

  /** The runner holds a request. A repeat of the same report changes nothing, not even an answer already given. */
  held(work: { work_id: string; thread: string; task_id: string }, report: { id: string; title: string; kind: string; detail: string }): void {
    this.sql`INSERT OR IGNORE INTO res_machine_perms VALUES (${report.id}, ${work.work_id}, ${work.thread}, ${work.task_id}, ${report.title}, ${report.kind}, ${report.detail}, ${Date.now()}, ${null})`;
  }

  /** Settled somewhere: the item is gone. Only the work that reported it can close it. */
  closed(workId: string, id: string): void {
    this.sql`DELETE FROM res_machine_perms WHERE id = ${id} AND work_id = ${workId}`;
  }

  /** The turn ended: nothing it held is still open. */
  clearWork(workId: string): void {
    this.sql`DELETE FROM res_machine_perms WHERE work_id = ${workId}`;
  }

  /** Waiting for the owner. */
  pending(now = Date.now()): Perm[] {
    this.sql`DELETE FROM res_machine_perms WHERE at < ${now - PERM_HOLD_MS - SLACK_MS}`;
    return this.sql<{ id: string; thread: string; task_id: string; title: string; kind: string; detail: string; at: number }>`SELECT * FROM res_machine_perms WHERE answer IS NULL ORDER BY at DESC`
      .map((row) => ({ id: row.id, thread: row.thread, task: row.task_id, title: row.title, kind: row.kind, detail: row.detail, at: row.at }));
  }

  /** The owner's button. False when it is not waiting any more (answered, closed, timed out). */
  answer(id: string, allow: boolean): boolean {
    if (!this.pending().some((perm) => perm.id === id)) return false;
    this.sql`UPDATE res_machine_perms SET answer = ${allow ? 1 : 0} WHERE id = ${id} AND answer IS NULL`;
    return true;
  }

  /** Answers the runner has not closed yet, for its poll. */
  answers(): { id: string; allow: boolean }[] {
    return this.sql<{ id: string; answer: number }>`SELECT id, answer FROM res_machine_perms WHERE answer IS NOT NULL`.map((row) => ({ id: row.id, allow: row.answer === 1 }));
  }
}
