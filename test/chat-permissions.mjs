// Shared approval state, chat rendering, and the permission-report push trigger.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { build, transform } from 'esbuild';

const bundled = await build({ entryPoints: ['src/machine.ts', 'src/cloud-tasks.ts', 'src/waiting-store.ts', 'src/chat-permissions.ts'], bundle: true, platform: 'node', format: 'esm', outdir: '/unused', write: false });
const modules = await Promise.all(bundled.outputFiles.map(async (file) => [file.path.split('/').pop(), await import('data:text/javascript;base64,' + Buffer.from(file.text).toString('base64'))]));
const loaded = Object.fromEntries(modules);
const { MachineStore, machineReply } = loaded['machine.js'];
const { TaskStore } = loaded['cloud-tasks.js'];
const { WaitingStore } = loaded['waiting-store.js'];
const { chatPermissions } = loaded['chat-permissions.js'];
const source = readFileSync('src/resident.ts', 'utf8');
// Execute the real orchestration method, with real machine and Waiting stores.
const method = source.slice(source.indexOf('  async machineRequest('), source.indexOf('\n  /** A file handed', source.indexOf('  async machineRequest(')));
const compiled = await transform('class Host {' + method + '\n}', { loader: 'ts', target: 'es2022' });
const Host = vm.runInNewContext(compiled.code + '; Host', { machineReply });

async function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = (strings, ...values) => { const stmt = db.prepare(strings.join('?')); return /^\s*SELECT/i.test(strings[0]) ? stmt.all(...values) : (stmt.run(...values), []); };
  const tasks = new TaskStore(sql);
  const machines = new MachineStore(sql, tasks, (fn) => fn());
  const { token } = await machines.register({ label: 'Synthetic runner' }, true);
  await machines.heartbeat(token);
  const { task } = tasks.add({ title: 'Synthetic approval', job: 'Run a command', execution: 'machine' });
  machines.enqueue(task, 'job', 'Run a command');
  const { work } = await machines.poll(token, { claimKey: 'ck_aaaaaaaa' });
  const waiting = new WaitingStore(sql, tasks, machines);
  const host = new Host();
  host.machines = () => machines;
  const pushes = [];
  host.pushWaitingAsks = async () => pushes.push(...waiting.unpushed());
  const report = { workId: work.workId, token: work.token, id: 'p_0123456789', state: 'held', title: 'Run command', kind: 'other', detail: 'example --check' };
  return { machines, waiting, host, token, report, pushes };
}

await test('a live approval appears in chat and pushes once on the held report', async () => {
  const f = await fixture();
  assert.equal((await f.host.machineRequest(f.token, 'permission', f.report)).status, 200);
  const cards = chatPermissions(f.waiting.list().items);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].detail, 'example --check');
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].tag, 'permission');
  await f.host.machineRequest(f.token, 'permission', f.report);
  assert.equal(f.pushes.length, 1, 'repeat reports do not push again');
  const bad = { ...f.report, token: 'invalid' };
  assert.equal((await f.host.machineRequest(f.token, 'permission', bad)).status, 409);
  assert.equal(f.pushes.length, 1);
});

await test('answering in Waiting or closing on the desktop clears the shared chat projection', async () => {
  for (const settle of ['allow', 'deny', 'desktop']) {
    const f = await fixture();
    await f.host.machineRequest(f.token, 'permission', f.report);
    if (settle === 'desktop') await f.host.machineRequest(f.token, 'permission', { workId: f.report.workId, token: f.report.token, id: f.report.id, state: 'closed' });
    else assert.equal(f.waiting.decide(f.report.id, settle === 'allow'), true);
    assert.deepEqual(chatPermissions(f.waiting.list().items), [], settle);
    assert.deepEqual(f.waiting.list().items, [], settle);
  }
});

function page() {
  const context = vm.createContext({ document: { documentElement: { dataset: {} } }, localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} }, window: {}, console, Date, setTimeout, clearTimeout });
  for (const path of ['public/app.js', 'public/waiting.js', 'public/chat-permissions.js']) vm.runInContext(readFileSync(path, 'utf8'), context);
  return vm.runInContext('resident()', context);
}
const item = { id: 't:perm:p_0123456789', kind: 'permission', perm: 'p_0123456789', detail: '<script>unsafe</script>' };
await test('same-version polling synchronizes cards and clears decisions made elsewhere', () => {
  const p = page();
  p.took({ same: true, rev: '1', permissions: [item] });
  assert.equal(p.rows().filter((row) => row.type === 'permission').length, 1);
  const question = { id: 't:ask:q', kind: 'ask', askKind: 'question', thread: 't', options: ['A'] };
  p.took({ same: true, rev: '1', permissions: [], waiting: { items: [question], open: 1, unread: {} } });
  assert.equal(p.rows().filter((row) => row.type === 'permission').length, 0);
  assert.equal(p.waitList.items.length, 1, 'a remaining question survives the permission closure');
  assert.equal(p.waitList.items[0].id, question.id);
});
await test('typed receipt approvals appear in chat and route both decisions to the original task', async () => {
  const approval = { id: 't:ask:a', kind: 'ask', askKind: 'permission', task: 'original-task', options: [] };
  assert.equal(chatPermissions([approval, { ...approval, askKind: 'question' }]).length, 1);
  for (const allow of [true, false]) {
    const p = page();
    p.syncChatPermissions({ permissions: [approval] });
    const calls = [];
    p.api = async (route, options) => { calls.push([route, options]); return { items: [], open: 0, unread: {} }; };
    p.refresh = async () => p.took({ same: true, permissions: [] });
    await p.answerChatPermission(approval, allow);
    assert.equal(calls[0][0], '/web/task/choose');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), { id: 'original-task', text: allow ? 'Allow' : 'Deny' });
    assert.equal(p.chatPermissions.length, 0);
  }
});

await test('chat Allow and Deny use the shared authenticated endpoint and refresh both projections', async () => {
  for (const allow of [true, false]) {
    const p = page();
    p.syncChatPermissions({ permissions: [item] });
    const calls = [];
    p.api = async (route, options) => { calls.push([route, options]); return { items: [], open: 0, unread: {} }; };
    p.refresh = async () => p.took({ same: true, permissions: [] });
    await p.answerChatPermission(item, allow);
    assert.equal(calls[0][0], '/web/waiting/permission');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), { id: item.perm, allow });
    assert.equal(p.chatPermissions.length, 0);
    assert.equal(p.waitList.items.length, 0);
  }
  const html = readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('x-text="row.permission.detail"'), 'command is rendered as text');
  assert.ok(html.includes(':disabled="Boolean(choosing)"'), 'double decisions are disabled');
});
