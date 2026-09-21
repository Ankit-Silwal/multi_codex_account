import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCodex } from './runner.js';
export function overlaps(a, b) {
  const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  return inside(a, b) || inside(b, a);
}
export class Scheduler extends EventEmitter {
  constructor(store, config, runner = runCodex) {
    super(); this.store = store; this.config = config; this.runner = runner; this.active = new Map(); this.stopped = false;
  }
  ready(account) { return account.apiKeyEnv ? Boolean(process.env[account.apiKeyEnv]) : existsSync(path.join(this.config.dataDir, 'accounts', account.id, 'auth.json')); }
  accountStatus(account) {
    if (!account.enabled) return 'paused';
    if (!this.ready(account)) return 'needs_login';
    if (account.cooldownUntil > Date.now()) return 'cooldown';
    if ([...this.active.values()].some(a => a.accountId === account.id)) return 'busy';
    return 'ready';
  }
  changed() { this.store.save(); this.emit('change'); }
  submit(input) {
    const job = { id: randomUUID(), ...input, status: 'queued', createdAt: new Date().toISOString(), attempts: [], events: [], output: '', error: null };
    this.store.state.jobs.push(job); this.changed(); this.tick(); return job;
  }
  tick() {
    if (this.stopped) return;
    for (const job of this.store.state.jobs) {
      if (this.active.size >= this.config.concurrency) break;
      if (job.status !== 'queued' && job.status !== 'waiting') continue;
      if ([...this.active.values()].some(a => overlaps(a.workspace, job.workspace))) continue;
      const candidates = this.store.state.accounts.filter(a => this.accountStatus(a) === 'ready' && (!job.accountId || a.id === job.accountId || job.autoFailover && job.attempts.length > 0));
      candidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
      if (!candidates.length) {
        if (job.status !== 'waiting') { job.status = 'waiting'; this.changed(); }
        continue;
      }
      this.start(job, candidates[0]);
    }
  }
  start(job, account) {
    const controller = new AbortController();
    this.active.set(job.id, { controller, accountId: account.id, workspace: job.workspace });
    job.status = 'running'; job.error = null; account.lastUsedAt = Date.now();
    const attempt = { accountId: account.id, accountName: account.name, startedAt: new Date().toISOString(), status: 'running' };
    job.attempts.push(attempt); this.changed();
    const onEvent = event => {
      job.events.push({ at: new Date().toISOString(), accountId: account.id, event });
      if (job.events.length > 150) job.events.shift();
      this.emit('change');
    };
    Promise.resolve().then(() => this.runner({ account, job, config: this.config, signal: controller.signal, onEvent })).catch(error => ({ ok: false, error: error.message })).then(result => {
      attempt.finishedAt = new Date().toISOString(); attempt.usage = result.usage || null;
      attempt.status = controller.signal.aborted ? 'cancelled' : result.ok ? 'completed' : result.quota ? 'limited' : 'failed';
      attempt.error = result.ok ? null : result.error;
      if (result.output) job.output = result.output;
      if (result.quota) { account.cooldownUntil = Date.now() + this.config.cooldownMs; account.lastError = result.error; }
      if (controller.signal.aborted) job.status = 'cancelled';
      else if (result.ok) { job.status = 'completed'; account.lastError = null; }
      else if (result.quota && job.autoFailover && job.attempts.length < this.config.maxAttempts) {
        if (job.sandbox === 'workspace-write' && !job.allowWriteRetry) {
          job.status = 'needs_review'; job.error = 'Quota reached after a write-enabled attempt. Review the workspace, then retry or enable write retries on a new job.';
        } else { job.status = 'waiting'; job.error = result.error; }
      } else { job.status = 'failed'; job.error = result.error || 'Codex failed.'; }
      if (!['queued', 'waiting', 'running'].includes(job.status)) job.finishedAt = new Date().toISOString();
      this.active.delete(job.id); this.changed(); this.tick();
    });
  }
  cancel(job) {
    if (!['queued', 'waiting', 'running'].includes(job.status)) throw Object.assign(new Error('This job is no longer active.'), { status: 409 });
    const active = this.active.get(job.id);
    if (active) active.controller.abort();
    else { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); }
    this.changed();
  }
  async stop() {
    this.stopped = true;
    for (const active of this.active.values()) active.controller.abort();
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 30));
  }
}
