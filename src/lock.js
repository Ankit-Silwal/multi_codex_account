import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
// The JSON store has one writer. Claim its directory before loading or recovering jobs.
export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8') === String(process.pid))
            unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error(
          `Invalid server lock at ${file}. Check that no server is running before removing it.`,
        );
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') {
          unlinkSync(file);
          continue;
        }
      }
      throw new Error(
        `An existing server owns this data directory (PID ${pid}). Stop it before starting another instance.`,
      );
    }
  }
  throw new Error('Could not acquire the data directory lock.');
}
