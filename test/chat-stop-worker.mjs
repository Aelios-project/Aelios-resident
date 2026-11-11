// Run against a fresh local fake Worker and this branch's mock-server on :9999.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.WORKER_URL || 'http://127.0.0.1:18811';
const mock = process.env.MOCK_URL || 'http://127.0.0.1:9999';
const headers = { 'x-web-key': 'test-web-key', 'content-type': 'application/json' };
async function api(path, body, status = 200) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, path);
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await api('/web/messages');
    if (check(state)) return state;
    await delay(80);
  }
  assert.fail('Expected chat state did not arrive');
}
async function faults(body) {
  const response = await fetch(mock + '/__faults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
}

const denied = await fetch(base + '/web/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(denied.status, 401);
assert.equal((await api('/web/stop', {})).status, 'idle');
await api('/web/stop', { requestId: false }, 400);
const malformed = await fetch(base + '/web/stop', { method: 'POST', headers, body: '{' });
assert.equal(malformed.status, 400);
console.log('PASS stop uses existing authentication and validates bodies');

await api('/web/model', { text: 'fake' });
const slow = api('/web/say', { text: '\u6162\u6162\u8bf4' });
const live = await until(state => state.turn && state.data.some(line => line.pending && line.text));
const current = live.turn.requestId;
const user = live.data.findLast(line => line.role === 'user');
await api('/web/stop', { requestId: 'stale-turn' }, 409);
assert.equal((await api('/web/messages')).turn.requestId, current);
assert.equal((await api('/web/stop', { requestId: current })).status, 'stopping');
assert.equal((await slow).status, 'aborted');
const stopped = await until(state => state.turn === null && !state.data.some(line => line.pending));
assert.ok(stopped.data.some(line => line.id === user.id));
assert.equal(stopped.data.slice(stopped.data.findIndex(line => line.id === user.id) + 1).filter(line => line.role === 'assistant').length, 0);
assert.equal((await api('/web/stop', { requestId: current })).status, 'idle');
console.log('PASS stopping mid-reply removes the actual persisted partial, retains the user message, and clears pending state');

assert.equal((await api('/web/say', { text: 'A normal reply after stopping' })).status, 'completed');
const after = await api('/web/messages');
assert.equal(after.turn, null);
assert.ok(after.data.at(-1).role === 'assistant' && !after.data.at(-1).pending);
console.log('PASS the next normal turn runs and finishes without a stuck typing state');

try {
  await faults({ slowRecallMs: 4000 });
  const request = api('/web/say', { text: '\u5e2e\u6211\u67e5\u8bb0\u5fc6' });
  const tools = await until(state => state.turn && state.data.some(line => line.pending && line.activity?.some(item => item.type === 'tool' && item.name === 'memory_recall')));
  const id = tools.turn.requestId;
  const input = tools.data.findLast(line => line.role === 'user');
  await api('/web/stop', { requestId: id });
  assert.equal((await request).status, 'aborted');
  const clean = await until(state => state.turn === null && !state.data.some(line => line.pending));
  assert.equal(clean.data.slice(clean.data.findIndex(line => line.id === input.id) + 1).filter(line => line.role === 'assistant').length, 0);
  console.log('PASS stopping during a real tool execution prevents a follow-up answer and removes incomplete tool history');
} finally {
  await faults({ slowRecallMs: 0 });
}
assert.equal((await api('/web/say', { text: 'A normal reply after a stopped tool' })).status, 'completed');
console.log('PASS chat remains usable after tool cancellation');
