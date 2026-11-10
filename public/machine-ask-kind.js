// Receipt asks describe a completed turn waiting for input, not a live permission handle.
function machineAskKindLabel(kind) {
  return kind === 'permission' ? 'Waiting for approval' : kind === 'question' ? 'Waiting for an answer' : '';
}

function machineThreadAskLabel(thread) {
  if (thread.runs !== 'machine') return '';
  var latest = (thread.tasks || []).at(-1);
  if ((latest ? latest.status : thread.status) !== 'needs_you') return '';
  var ask = (thread.asks || [])[0];
  return machineAskKindLabel(ask && ask.kind);
}
