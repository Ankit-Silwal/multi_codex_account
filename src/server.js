import { mkdirSync } from 'node:fs';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';
const config = getConfig();
const releaseLock = acquireLock(config.dataDir);
process.on('exit', releaseLock);
mkdirSync(config.workspaceRoot, { recursive: true });
const store = new Store(config.dataDir);
const scheduler = new Scheduler(store, config);
const server = createApp({ store, scheduler, config }).listen(
  config.port,
  config.host,
  () => {
    console.log(
      `Codex Switchboard: http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`,
    );
    console.log('Sign in using ADMIN_TOKEN in .env.');
    scheduler.tick();
  },
);
server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
const timer = setInterval(() => scheduler.tick(), 1000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close();
  await scheduler.stop();
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
