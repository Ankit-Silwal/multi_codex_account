import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runCodex } from '../src/runner.js';
const command = {
  file: process.execPath,
  prefix: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url))],
};
function run(prompt, extra = {}) {
  return runCodex({
    command,
    account: { id: 'fixture' },
    job: {
      workspace: process.cwd(),
      sandbox: 'read-only',
      prompt,
      attempts: [{}],
    },
    config: { dataDir: process.cwd(), timeoutMs: 5000 },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...extra,
  });
}
test('CLI adapter parses JSONL, Unicode, and usage without rotating on model text', async () => {
  const events = [];
  const result = await run('normal', {
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(result.quota, false);
  assert.equal(result.usage.output_tokens, 5);
  assert.match(result.output, /café ✓/);
  assert.equal(events.length, 3);
});
test('CLI adapter reports quota errors only on failed attempts', async () => {
  const result = await run('quota-failure');
  assert.equal(result.ok, false);
  assert.equal(result.quota, true);
  const coded = await run('coded-failure');
  assert.equal(coded.quota, true);
  const recovered = await run('recovered');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.quota, false);
});
test('zero exit without a completed turn is not success', async () => {
  const result = await run('no-completion');
  assert.equal(result.ok, false);
  assert.match(result.error, /without a completed turn/);
});
test('CLI adapter terminates on timeout and user cancellation', async () => {
  const timed = await run('hang', {
    config: { dataDir: process.cwd(), timeoutMs: 100 },
  });
  assert.equal(timed.ok, false);
  assert.equal(timed.quota, false);
  assert.match(timed.error, /timed out/);
  const controller = new AbortController();
  const pending = run('hang', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.quota, false);
});
