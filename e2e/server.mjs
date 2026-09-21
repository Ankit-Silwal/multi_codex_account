import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';
const dir = mkdtempSync(path.join(tmpdir(), 'switchboard-browser-'));
const config = {
  dataDir: path.join(dir, 'data'),
  workspaceRoot: path.join(dir, 'projects'),
  concurrency: 3,
  cooldownMs: 60000,
  maxAttempts: 3,
  model: '',
  token: 'browser-test-token-not-a-real-secret',
};
mkdirSync(config.workspaceRoot);
mkdirSync(path.join(config.workspaceRoot, 'demo'));
const store = new Store(config.dataDir);
store.state.accounts.push(
  { id: 'studio', name: 'Studio', enabled: true },
  { id: 'work', name: 'Work', enabled: true },
);
const scheduler = new Scheduler(store, config, async ({ account, onEvent }) => {
  onEvent({ type: 'thread.started', thread_id: 'browser-fixture' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (account.id === 'studio')
    return {
      ok: false,
      quota: true,
      error: 'Usage limit reached (test fixture).',
    };
  onEvent({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Browser test completed successfully.',
    },
  });
  return {
    ok: true,
    output: 'Browser test completed successfully.',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
});
scheduler.ready = (account) => ['studio', 'work'].includes(account.id);
const server = createApp({ store, scheduler, config }).listen(
  3211,
  '127.0.0.1',
);
const timer = setInterval(() => scheduler.tick(), 100);
async function stop() {
  clearInterval(timer);
  await scheduler.stop();
  server.closeAllConnections();
  server.close(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit();
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
