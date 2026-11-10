import type { Sql } from "./sticker-store";
import { machinePick, type MachinePick } from "./role-model";

/** A work item's requested model, frozen when it is put in line rather than looked up when it is polled. */
export class MachineJobModels {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_machine_models (work_id TEXT PRIMARY KEY, model TEXT NOT NULL, family TEXT NOT NULL)`;
  }

  set(workId: string, role: MachinePick | null): void {
    const { model, family } = machinePick(role);
    if (model) this.sql`INSERT INTO res_machine_models (work_id, model, family) VALUES (${workId}, ${model}, ${family ?? ""})`;
  }

  get(workId: string): { model?: string; family?: string } {
    const [row] = this.sql<{ model: string; family: string }>`SELECT model, family FROM res_machine_models WHERE work_id = ${workId}`;
    return row?.model ? { model: row.model, ...(row.family ? { family: row.family } : {}) } : {};
  }

  forThread(thread: string): string {
    const [row] = this.sql<{ model: string | null }>`SELECT m.model FROM res_machine_work w
      LEFT JOIN res_machine_models m ON m.work_id = w.work_id
      WHERE w.thread = ${thread} AND w.kind != 'cancel' ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1`;
    return row?.model ?? "";
  }

  prune(): void {
    this.sql`DELETE FROM res_machine_models WHERE work_id NOT IN (SELECT work_id FROM res_machine_work)`;
  }
}

/** A request, not a claim about which model the helper ran. */
export function requestedModelLabel(helper: string, model: string): string {
  return [helper, model ? `要的模型 ${model}` : ""].filter(Boolean).join(" · ");
}
