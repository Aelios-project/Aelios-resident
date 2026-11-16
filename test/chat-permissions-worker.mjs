// Real local Worker HTTP regression. Requires wrangler.test.jsonc and test/mock-server.mjs.
import assert from 'node:assert/strict';
const base = process.env.WORKER_URL || 'http://127.0.0.1:18813';
async function call(path, body, token) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : { 'x-web-key': 'test-web-key' }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
await call('/web/config', { key: 'CLOUD_TASKS', text: 'on' });
const { token } = await call('/web/runner/register', { label: 'Synthetic approval runner' });
await call('/runner/v1/heartbeat', {}, token);
await call('/web/say', { text: '\u673a\u5668\u6d3e\u6d3b SyntheticApproval' });
const { work } = await call('/runner/v1/poll', { claimKey: 'ck_aaaaaaaa' }, token);
assert.ok(work, 'the scripted model dispatched a machine task');
const report = { workId: work.workId, token: work.token, state: 'held', title: 'Run command', kind: 'other', detail: 'example --check' };
async function hold(id) { await call('/runner/v1/permission', { ...report, id }, token); }
await hold('p_0123456789');
let messages = await call('/web/messages');
assert.equal(messages.permissions.length, 1);
assert.deepEqual(messages.waiting, await call('/web/waiting'), 'chat polling carries the authoritative Waiting snapshot');
assert.equal(messages.permissions[0].detail, 'example --check');
assert.deepEqual(messages.permissions, (await call('/web/waiting')).items.filter((item) => item.kind === 'permission'));
const repeat = await call('/web/messages?since=' + encodeURIComponent(messages.rev));
assert.equal(repeat.permissions.length, 1, 'incremental polling retains the card');
console.log('PASS held permission is shared by main chat and Waiting over HTTP');
for (const allow of [true, false]) {
  await call('/web/waiting/permission', { id: 'p_0123456789', allow });
  assert.deepEqual((await call('/web/messages?since=' + encodeURIComponent(messages.rev))).permissions, []);
  assert.deepEqual((await call('/web/waiting')).items, []);
  const polled = await call('/runner/v1/poll', { claimKey: 'ck_aaaaaaaa' }, token);
  assert.ok(polled.answers.some((answer) => answer.id === 'p_0123456789' && answer.allow === allow));
  await call('/runner/v1/permission', { workId: work.workId, token: work.token, id: 'p_0123456789', state: 'closed' }, token);
  await hold('p_0123456789');
}
console.log('PASS Allow and Deny in Waiting remove the main-chat card and reach the runner');
await call('/runner/v1/permission', { workId: work.workId, token: work.token, id: 'p_0123456789', state: 'closed' }, token);
assert.deepEqual((await call('/web/messages')).permissions, []);
console.log('PASS a desktop close removes the main-chat card');
// A held request that ran out of time ends the turn with an approval ask that offers a one-time grant (machine-grant.ts).
await call('/runner/v1/heartbeat', {}, token);
await call('/runner/v1/receipt', { receiptId: work.workId + ':final', workId: work.workId, token: work.token, type: 'final', status: 'needs_you', summary: 'Held and not answered.', ask: { key: 'perm:grant', kind: 'permission', grant: 'g_0123456789', question: 'The helper wanted to run example --check.' } }, token);
const asked = (await call('/web/messages')).permissions.find((item) => item.kind === 'ask' && item.askKind === 'permission');
assert.ok(asked, 'the approval ask shows in the chat');
assert.ok(!JSON.stringify(await call('/web/messages')).includes('g_0123456789'), 'the page never sees the grant');
await call('/web/task/choose', { id: asked.task, text: '允许' });
const followed = (await call('/runner/v1/poll', { claimKey: 'ck_bbbbbbbb' }, token)).work;
assert.equal(followed.kind, 'say');
assert.equal(followed.grant, 'g_0123456789', 'her 允许 carries the grant to the runner');
assert.match(followed.text, /^允许。.*same action again/);
assert.deepEqual((await call('/web/messages')).permissions, [], 'the card is gone once she answered');
console.log('PASS 允许 on an approval that ran out of time sends a follow-up with the one-time grant');
await call('/runner/v1/receipt', { receiptId: followed.workId + ':final', workId: followed.workId, token: followed.token, type: 'final', status: 'needs_you', summary: 'Held again.', ask: { key: 'perm:grant2', kind: 'permission', grant: 'g_abcdefabcd', question: 'The helper wanted to run example --fix.' } }, token);
const denied = (await call('/web/messages')).permissions.find((item) => item.kind === 'ask');
await call('/web/task/choose', { id: denied.task, text: '拒绝' });
const refused = (await call('/runner/v1/poll', { claimKey: 'ck_cccccccc' }, token)).work;
assert.equal(refused.text, '拒绝');
assert.equal(Object.hasOwn(refused, 'grant'), false, '拒绝 never carries a grant');
console.log('PASS 拒绝 sends no grant');
