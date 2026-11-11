// Why a thread on the waiting list waits, from src/waiting-merge.ts (one card per thread, the reasons it waits for).
// A thread waiting more than one way says each reason; the permission comes first because it is the one with buttons.
function waitingReasonLabel(reason) {
  if (reason === 'permission') return '等你批准';
  if (reason === 'question') return '等你回答';
  return '等你';
}
