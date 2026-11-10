// Receipt asks describe a completed turn waiting for input, not a live permission handle.
function machineAskKindLabel(kind) {
  return kind === 'permission' ? '等你批准' : kind === 'question' ? '等你回答' : '';
}

function machineThreadAskLabel(thread) {
  if (thread.runs !== 'machine') return '';
  var latest = (thread.tasks || []).at(-1);
  if ((latest ? latest.status : thread.status) !== 'needs_you') return '';
  var ask = (thread.asks || [])[0];
  return machineAskKindLabel(ask && ask.kind);
}
