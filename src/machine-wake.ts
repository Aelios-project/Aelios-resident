// When a finished machine thread makes the resident speak. A thread the owner talks to directly ("say") already shows
// its own words in the thread, and a stopped or waiting one is on the waiting list: only a job or a mail that ended
// done or failed is told to the owner, once, in the resident's own words (the same turn a cloud task starts).
import type { WorkKind } from "./machine";

export function wakesResident(finished: { kind: WorkKind; status: string }): boolean {
  return finished.kind !== "say" && (finished.status === "done" || finished.status === "failed");
}
