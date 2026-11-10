import type { Sql } from "./sticker-store";

export type AskKind = "permission" | "question";

/** No kind is the original protocol. A stopped helper is a failure, never a problem ask. */
export function validAskKind(value: unknown): value is AskKind | undefined {
  return value === undefined || value === "permission" || value === "question";
}

export function askKindFields(value: string): { kind?: AskKind } {
  return value === "permission" || value === "question" ? { kind: value } : {};
}

/** Existing unresolved asks retain their original unspecified behavior. */
export function initAskKind(sql: Sql): void {
  if (!sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('res_machine_asks') WHERE name = 'kind'`[0].n) {
    sql`ALTER TABLE res_machine_asks ADD COLUMN kind TEXT NOT NULL DEFAULT ''`;
  }
}
