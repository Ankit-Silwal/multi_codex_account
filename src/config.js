import path from 'node:path';
export function getConfig(env = process.env) {
  const integer = (name, fallback, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  if (
    !env.ADMIN_TOKEN ||
    env.ADMIN_TOKEN.length < 24 ||
    env.ADMIN_TOKEN.startsWith('replace-')
  )
    throw new Error(
      'Run npm run setup or set ADMIN_TOKEN to a random secret of at least 24 characters.',
    );
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new Error(
      'This local account manager must bind to a loopback address. Use an authenticated TLS tunnel for remote access.',
    );
  return {
    host,
    port: integer('PORT', 3210, 65535),
    token: env.ADMIN_TOKEN,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    workspaceRoot: path.resolve(env.WORKSPACE_ROOT || 'workspaces'),
    concurrency: integer('MAX_CONCURRENT_JOBS', 3, 20),
    cooldownMs: integer('ACCOUNT_COOLDOWN_SECONDS', 3600, 604800) * 1000,
    timeoutMs: integer('JOB_TIMEOUT_SECONDS', 1800, 86400) * 1000,
    maxAttempts: integer('MAX_JOB_ATTEMPTS', 5, 20),
    model: env.CODEX_MODEL || '',
  };
}
