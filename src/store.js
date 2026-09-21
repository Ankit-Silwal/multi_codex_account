import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { accounts: [], jobs: [] };
    if (!Array.isArray(this.state.accounts) || !Array.isArray(this.state.jobs)) throw new Error('Invalid state file; restore a backup.');
    for (const job of this.state.jobs) if (job.status === 'running') {
      job.status = 'interrupted'; job.error = 'Server stopped during this job. Review changes before retrying.';
      const attempt = job.attempts.at(-1);
      if (attempt && !attempt.finishedAt) { attempt.status = 'interrupted'; attempt.finishedAt = new Date().toISOString(); }
    }
    this.save();
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
