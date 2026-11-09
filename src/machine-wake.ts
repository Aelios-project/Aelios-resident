// When a finished machine thread makes the resident speak: any turn of it that ended done or failed, whether the
// resident sent it or the owner wrote to the thread directly, once, in the resident's own words (the same turn a cloud
// task starts). A stopped or waiting one is on the waiting list and only leaves a record.
export function wakesResident(finished: { status: string }): boolean {
  return finished.status === "done" || finished.status === "failed";
}
