// Reads what the waiting list is made of, and keeps two small things: which items were read, and which asks were pushed.
import type { TaskStore } from "./cloud-tasks";
import type { MachineStore } from "./machine";
import type { Sql } from "./sticker-store";
import { ITEM_DROPPED_MS, askPush, build, type WaitingItem } from "./waiting";

const THREADS_LOOKED_AT = 100;

export class WaitingStore {
  constructor(private readonly sql: Sql, private readonly tasks: TaskStore, private readonly machines: MachineStore) {
    sql`CREATE TABLE IF NOT EXISTS res_waiting_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`;
  }

  #built(now: number) {
    this.sql`DELETE FROM res_waiting_seen WHERE at < ${now - ITEM_DROPPED_MS}`;
    const threads = this.tasks.threads(THREADS_LOOKED_AT).flatMap((card) => {
      const task = this.tasks.latest(card.id);
      return task && !task.test && task.runs !== "retired"
        ? [{ id: card.id, taskId: task.id, title: card.title, status: task.status, runs: task.runs, summary: task.summary, choices: task.choices ?? [], reason: task.reason ?? "", waiting: card.waiting, updatedAt: task.updatedAt }]
        : [];
    });
    const seen = new Set(this.sql<{ id: string }>`SELECT id FROM res_waiting_seen`.map((row) => row.id));
    return build({ asks: this.machines.allAsks(), perms: this.machines.perms.pending(), notes: this.machines.notes(), threads, seen, now });
  }

  /** What needs the owner, how many asks are open, and the unread news per thread. */
  list(now = Date.now()): { items: WaitingItem[]; open: number; unread: Record<string, number> } {
    const { items, news } = this.#built(now);
    const unread: Record<string, number> = {};
    for (const item of news) unread[item.thread] = (unread[item.thread] ?? 0) + 1;
    return { items, open: items.length, unread };
  }

  /** The owner opened a thread (or null: read everything): its news counts as read. */
  read(thread: string | null): void {
    const now = Date.now();
    const { news } = this.#built(now);
    for (const item of news) if (thread === null || item.thread === thread) this.sql`INSERT OR REPLACE INTO res_waiting_seen VALUES (${item.id}, ${now})`;
  }

  /** The owner put a stuck item aside: it leaves the list until the thread fails again (a new failure is a new item). */
  dismiss(id: string): void {
    const now = Date.now();
    if (this.#built(now).items.some((item) => item.kind === "stuck" && item.id === id)) this.sql`INSERT OR REPLACE INTO res_waiting_seen VALUES (${id}, ${now})`;
  }

  /** The owner's Allow / Deny on a held permission. False when it is no longer waiting. */
  decide(perm: string, allow: boolean): boolean {
    return this.machines.perms.answer(perm, allow);
  }

  /** The pushes still to send: each open ask once. */
  unpushed(): { body: string; tag: string }[] {
    const out: { body: string; tag: string }[] = [];
    for (const item of this.list().items) {
      if (item.kind !== "ask" && item.kind !== "permission") continue;
      const mark = `push:${item.id}`;
      if (this.sql`SELECT 1 FROM res_waiting_seen WHERE id = ${mark}`.length) continue;
      this.sql`INSERT INTO res_waiting_seen VALUES (${mark}, ${Date.now()})`;
      out.push(askPush(item));
    }
    return out;
  }
}
