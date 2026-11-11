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
