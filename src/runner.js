import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
const require = createRequire(import.meta.url);
export function codexCommand() {
  return { file: process.execPath, prefix: [path.join(path.dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')] };
}
export function accountEnv(account, dataDir, source = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) if (source[key]) env[key] = source[key];
  env.CODEX_HOME = path.join(dataDir, 'accounts', account.id);
  if (account.apiKeyEnv) env.CODEX_API_KEY = source[account.apiKeyEnv];
  return env;
}
export function redact(text) {
  let safe = String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  for (const [name, value] of Object.entries(process.env)) if ((name === 'ADMIN_TOKEN' || /^ACCOUNT_.*_API_KEY$/.test(name)) && value?.length >= 8) safe = safe.split(value).join('[REDACTED]');
  return safe;
}
export function isQuotaError(message) {
  return /usage[_ ]limit[_ ]reached|rate[_ -]?limit|insufficient[_ ]quota|quota (?:exceeded|exhausted)|(?:hit|reached|exceeded) your usage limit|too many requests|\b429\b/i.test(message);
}
export function runCodex({ account, job, config, signal, onEvent }) {
  return new Promise((resolve) => {
    const command = codexCommand();
    const args = [...command.prefix, 'exec', '--json', '--color', 'never', '--sandbox', job.sandbox,
      '--config', 'cli_auth_credentials_store="file"', '--config', 'approval_policy="never"', '--cd', job.workspace, '--skip-git-repo-check'];
    if (job.model) args.push('--model', job.model);
    args.push('-');
    const child = spawn(command.file, args, { env: accountEnv(account, config.dataDir), cwd: job.workspace, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false, failure = '', stderr = '', output = '', usage = null, completed = false, pending = '', timedOut = false;
    const decoder = new StringDecoder('utf8');
    function stop() {
      if (!child.pid || finished) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
    const timer = setTimeout(() => { timedOut = true; stop(); }, config.timeoutMs);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop();
    function settle(result) {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result);
    }
    function line(text) {
      let event;
      try { event = JSON.parse(text); } catch { return; }
      onEvent(JSON.parse(redact(JSON.stringify(event))));
      if (event.type === 'turn.failed' || event.type === 'error') failure = typeof event.error === 'string' ? event.error : event.error?.message || event.message || JSON.stringify(event.error || {});
      if (event.type === 'turn.completed') { usage = event.usage; completed = true; failure = ''; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') output = redact(event.item.text || '').slice(-100000);
    }
    child.stdout.on('data', chunk => {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 2000000) { failure = 'CLI event exceeded the 2 MB limit.'; stop(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.stdin.on('error', () => {});
    child.on('error', err => settle({ ok: false, error: redact(err.message), quota: false }));
    child.on('close', code => {
      pending += decoder.end(); if (pending.trim()) line(pending);
      const error = redact(timedOut ? 'Job timed out.' : failure || stderr || `Codex exited with code ${code} without a completed turn.`);
      settle({ ok: code === 0 && completed && !failure && !timedOut && !signal.aborted, error, quota: !timedOut && !signal.aborted && isQuotaError(failure || stderr), output, usage });
    });
    const preamble = job.attempts.length > 1 ? 'A previous attempt was interrupted. Inspect the current files before acting; changes may already exist. Do not repeat completed actions blindly.\n\n' : '';
    child.stdin.end(preamble + job.prompt);
  });
}
