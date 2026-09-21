import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';
import { accountEnv, isQuotaError } from '../src/runner.js';
import { acquireLock } from '../src/lock.js';
function fixture(t, runner) {
  const dir = mkdtempSync(path.join(tmpdir(), 'switchboard-'));
  const config = {
    dataDir: path.join(dir, 'data'),
    workspaceRoot: path.join(dir, 'workspaces'),
    concurrency: 3,
    cooldownMs: 10000,
    maxAttempts: 3,
    token: 'test-secret-with-at-least-24-characters',
    model: '',
  };
  mkdirSync(config.workspaceRoot);
  mkdirSync(path.join(config.workspaceRoot, 'one'));
  mkdirSync(path.join(config.workspaceRoot, 'two'));
  const store = new Store(config.dataDir);
  store.state.accounts.push(
    ...['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      enabled: true,
      cooldownUntil: 0,
    })),
  );
  const scheduler = new Scheduler(store, config, runner);
  scheduler.ready = () => true;
  t.after(async () => {
    await scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, store, scheduler };
}
const input = (f, overrides = {}) => ({
  prompt: 'Inspect this project',
  workspace: path.join(f.config.workspaceRoot, 'one'),
  sandbox: 'read-only',
  autoFailover: true,
  ...overrides,
});
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting for state');
}
test('quota exhaustion automatically switches to another account and preserves attempt history', async (t) => {
  const f = fixture(t, async ({ account }) =>
    account.id === 'a'
      ? { ok: false, quota: true, error: 'Usage limit reached' }
      : {
          ok: true,
          output: 'done',
          usage: { input_tokens: 4, output_tokens: 3 },
        },
  );
  const job = f.scheduler.submit(input(f));
  await until(() => job.status === 'completed');
  assert.deepEqual(
    job.attempts.map((a) => a.accountId),
    ['a', 'b'],
  );
  assert.equal(job.output, 'done');
  assert.ok(f.store.state.accounts[0].cooldownUntil > Date.now());
});
test('concurrent accounts run separate workspaces; overlapping workspaces serialize', async (t) => {
  const pending = [];
  const f = fixture(
    t,
    ({ account, signal }) =>
      new Promise((resolve) => {
        pending.push({ account, resolve });
        signal.addEventListener('abort', () => resolve({ ok: false }));
      }),
  );
  const first = f.scheduler.submit(input(f));
  const second = f.scheduler.submit(input(f));
  const third = f.scheduler.submit(
    input(f, { workspace: path.join(f.config.workspaceRoot, 'two') }),
  );
  await until(() => pending.length === 2);
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'running');
  assert.notEqual(pending[0].account.id, pending[1].account.id);
  pending[0].resolve({ ok: true });
  await until(() => second.status === 'running');
});
test('write jobs require review unless automatic write retries are explicitly enabled', async (t) => {
  const f = fixture(t, async () => ({ ok: false, quota: true, error: '429' }));
  const job = f.scheduler.submit(input(f, { sandbox: 'workspace-write' }));
  await until(() => job.status === 'needs_review');
  assert.equal(job.attempts.length, 1);
});
test('explicit write retry opt-in fails over, while non-quota errors never rotate', async (t) => {
  const f = fixture(t, async ({ account }) =>
    account.id === 'a'
      ? { ok: false, quota: true, error: '429' }
      : { ok: true },
  );
  const job = f.scheduler.submit(
    input(f, { sandbox: 'workspace-write', allowWriteRetry: true }),
  );
  await until(() => job.status === 'completed');
  assert.equal(job.attempts.length, 2);
  f.scheduler.runner = async () => ({
    ok: false,
    error: 'Authentication failed',
  });
  const failed = f.scheduler.submit(input(f));
  await until(() => failed.status === 'failed');
  assert.equal(failed.attempts.length, 1);
});
test('all limited accounts wait without retry loops; cancellation ends a waiting job', async (t) => {
  const f = fixture(t, async () => ({ ok: false, quota: true, error: '429' }));
  f.config.maxAttempts = 5;
  const job = f.scheduler.submit(input(f));
  await until(() => job.status === 'waiting' && job.attempts.length === 3);
  for (let i = 0; i < 10; i++) f.scheduler.tick();
  assert.equal(job.attempts.length, 3);
  f.scheduler.cancel(job);
  assert.equal(job.status, 'cancelled');
});
test('restart marks running jobs interrupted instead of replaying actions', (t) => {
  const f = fixture(t);
  f.store.state.jobs.push({
    id: 'old',
    status: 'running',
    attempts: [{ status: 'running' }],
  });
  f.store.save();
  const restored = new Store(f.config.dataDir);
  assert.equal(restored.state.jobs[0].status, 'interrupted');
  assert.equal(restored.state.jobs[0].attempts[0].status, 'interrupted');
});
test('data directory lock refuses another writer and releases cleanly', (t) => {
  const f = fixture(t);
  const release = acquireLock(f.config.dataDir);
  assert.throws(() => acquireLock(f.config.dataDir), /existing server/);
  release();
  const releaseAgain = acquireLock(f.config.dataDir);
  releaseAgain();
});
test('child environments isolate credentials and omit dashboard and unrelated secrets', () => {
  const env = accountEnv({ id: 'a', apiKeyEnv: 'ACCOUNT_A_API_KEY' }, '/data', {
    PATH: '/bin',
    ADMIN_TOKEN: 'secret',
    OPENAI_API_KEY: 'wrong-account',
    CODEX_API_KEY: 'also-wrong',
    ACCOUNT_A_API_KEY: 'selected-key',
    ACCOUNT_B_API_KEY: 'other-key',
    GITHUB_TOKEN: 'private',
  });
  assert.equal(env.CODEX_API_KEY, 'selected-key');
  assert.equal(env.ADMIN_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ACCOUNT_B_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(isQuotaError('You have hit your usage limit'), true);
  assert.equal(isQuotaError('connection refused'), false);
});
test('HTTP authentication, origin checks, workspace containment, and input validation', async (t) => {
  const f = fixture(t, async () => ({ ok: true }));
  const server = createApp(f).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, body, extra = {}) =>
    fetch(base + url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${f.config.token}`,
        'Content-Type': 'application/json',
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await request('/api/state')).status, 200);
  assert.equal(
    (await request('/api/state', null, { Origin: 'https://evil.example' }))
      .status,
    403,
  );
  assert.equal(
    (await request('/api/jobs', { workspace: '../', prompt: 'x' })).status,
    400,
  );
  assert.equal(
    (
      await request('/api/jobs', {
        workspace: 'one',
        prompt: 'x',
        sandbox: 'danger-full-access',
      })
    ).status,
    400,
  );
  assert.equal(
    (await request('/api/accounts', { name: 'bad', apiKeyEnv: 'ADMIN_TOKEN' }))
      .status,
    400,
  );
  assert.equal((await request('/api/accounts', { name: 'new' })).status, 201);
  const login = await request('/api/session', { token: f.config.token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status,
    200,
  );
  const response = await request('/api/jobs', {
    workspace: 'one',
    prompt: 'x',
  });
  assert.equal(response.status, 201);
  const job = await response.json();
  await until(
    () =>
      f.store.state.jobs.find((j) => j.id === job.id).status === 'completed',
  );
});
