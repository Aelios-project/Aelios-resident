// Why a thread on the waiting list waits, from src/waiting-merge.ts (one card per thread, the reasons it waits for).
// A thread waiting more than one way says each reason; the permission comes first because it is the one with buttons.
function waitingReasonLabel(reason) {
  if (reason === 'permission') return '\u7b49\u4f60\u6279\u51c6';
  if (reason === 'question') return '\u7b49\u4f60\u56de\u7b54';
  return '\u7b49\u4f60';
}