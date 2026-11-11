import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/chat-stop.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { ChatStop, stopRequestId } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);

test('stop targets one active turn, is idempotent, and rejects stale controls', () => {
  const stop = new ChatStop();
  const cancelled = [];
  assert.deepEqual(stop.stop(undefined, id => cancelled.push(id)), { status: 'idle' });
  stop.start('first', () => true);
  assert.ok(stop.stop('old', id => cancelled.push(id)).error);
  assert.deepEqual(cancelled, []);
  assert.deepEqual(stop.stop('first', id => cancelled.push(id)), { status: 'stopping', requestId: 'first' });
  stop.stop('first', id => cancelled.push(id));
  assert.deepEqual(cancelled, ['first']);
});

test('cancelled partials are removed before the turn becomes idle', async () => {
  const stop = new ChatStop();
  stop.start('turn', () => true);
  stop.stop('turn', () => {});
  const history = new Map([['user', 'Keep the user message'], ['partial', 'Unfinished text']]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const finish = stop.finish({ requestId: 'turn', status: 'aborted', message: { id: 'partial' } }, async id => {
    await gate;
    history.delete(id);
  });
  assert.equal(stop.current().stopping, true);
  release();
  assert.equal(await finish, true);
  assert.deepEqual([...history.keys()], ['user']);
  assert.equal(stop.current(), null);
});

test('a late response hook cannot clear a newer turn or retain a stopped partial', async () => {
  const stop = new ChatStop();
  stop.start('old', () => true);
  stop.stop('old', () => {});
  stop.start('new', () => true);
  const removed = [];
  assert.equal(await stop.finish({ requestId: 'old', status: 'completed', message: { id: 'old-partial' } }, async id => removed.push(id)), true);
  assert.deepEqual(removed, ['old-partial']);
  assert.equal(stop.current().requestId, 'new');
  assert.ok(stop.stop('old', () => assert.fail('must not cancel the new turn')).error);
});

test('normal completion is retained and an inactive turn cannot be stopped', async () => {
  const stop = new ChatStop();
  let active = true;
  stop.start('done', () => active);
  assert.equal(await stop.finish({ requestId: 'done', status: 'completed', message: { id: 'answer' } }, async () => assert.fail('completed answer must stay')), false);
  stop.start('ended', () => active);
  active = false;
  assert.equal(stop.current(), null);
  assert.deepEqual(stop.stop(undefined, () => assert.fail('inactive turn')), { status: 'idle' });
});

test('stop request accepts an optional exact request id and rejects invalid bodies', () => {
  assert.deepEqual(stopRequestId({}), {});
  assert.deepEqual(stopRequestId({ requestId: 'turn-1' }), { requestId: 'turn-1' });
  for (const body of [null, [], 'turn', { requestId: false }, { requestId: '' }, { requestId: 'x'.repeat(201) }]) assert.ok(stopRequestId(body).error);
});

function page() {
  const context = vm.createContext({ console, Date, URL, Blob, TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout,
    document: { documentElement: { dataset: {} } }, window: {}, localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} } });
  vm.runInContext(readFileSync('public/chat-stop.js', 'utf8'), context);
  vm.runInContext(readFileSync('public/app.js', 'utf8'), context);
  const p = vm.runInContext('resident()', context);
  p.$refs = {};
  p.$nextTick = fn => fn();
  p.poll = () => {};
  p.notify = text => { p.notice = text; };
  return p;
}

test('page learns an active turn after reload, including a same-revision response', () => {
  const p = page();
  p.took({ rev: '1', data: [], turn: { requestId: 'running', stopping: false } });
  assert.equal(p.replying(), true);
  assert.equal(p.waiting(), true);
  p.took({ rev: '1', same: true, turn: null });
  assert.equal(p.replying(), false);
  assert.equal(p.waiting(), false);
});

test('stop UI suppresses duplicate clicks, refreshes state, and sends the observed id', async () => {
  const p = page();
  p.syncChatTurn({ requestId: 'running' });
  const requests = [];
  let release;
  p.api = async (path, options) => {
    requests.push([path, options.body.requestId]);
    await new Promise(resolve => { release = resolve; });
    return { status: 'stopping' };
  };
  p.refresh = async () => p.syncChatTurn(null);
  const first = p.stopReply();
  await p.stopReply();
  assert.equal(requests.length, 1);
  release();
  await first;
  assert.deepEqual(requests, [['/web/stop', 'running']]);
  assert.equal(p.stopReplyBusy, false);
  assert.equal(p.chatTurn, null);
});

test('an aborted send is not shown as a failed message or an endless typing state', async () => {
  const p = page();
  p.api = async () => ({ status: 'aborted' });
  p.refresh = p.loadTasks = p.loadModel = async () => {};
  await p.send({ text: 'Please stop this reply' }, { text: 'Please stop this reply' });
  assert.equal(p.sending, 0);
  assert.equal(p.outbox.length, 0);
  assert.equal(p.waiting(), false);
  assert.equal(p.notice, undefined);
});

test('stop button is accessible and loaded independently from the large page module', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('<script src="/chat-stop.js"></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/chat-stop.css">'));
  assert.match(html, /x-show="chatTurn"[^>]*@click="stopReply\(\)"/);
  assert.match(html, /aria-label="chatTurn[^\n]+停下这次回复/);
});
