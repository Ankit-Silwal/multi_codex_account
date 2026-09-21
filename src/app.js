import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlaps } from './scheduler.js';
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`Invalid ${label}.`);
  return value.trim();
};
export function createApp({ store, scheduler, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null },
      },
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  const valid = (value) =>
    typeof value === 'string' &&
    Buffer.byteLength(value) === Buffer.byteLength(config.token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(config.token));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.headers.origin &&
      req.headers.origin !== `${req.protocol}://${req.headers.host}`
    )
      return res
        .status(403)
        .json({ error: 'Cross-origin requests are blocked.' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res
        .status(403)
        .json({ error: 'Cross-site requests are blocked.' });
    next();
  });
  let loginWindow = 0,
    loginAttempts = 0;
  app.post('/api/session', (req, res) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 20)
      return res
        .status(429)
        .json({ error: 'Too many login attempts. Wait a minute.' });
    if (!valid(req.body?.token))
      return res.status(401).json({ error: 'Invalid dashboard token.' });
    res.cookie('switchboard', config.token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 8 * 3600000,
      path: '/api',
    });
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const cookie = req.headers.cookie
      ?.split('; ')
      .find((c) => c.startsWith('switchboard='))
      ?.slice(12);
    let decoded;
    try {
      decoded = decodeURIComponent(cookie || '');
    } catch {
      decoded = '';
    }
    if (!valid(bearer) && !valid(decoded))
      return res
        .status(401)
        .json({ error: 'Sign in with your ADMIN_TOKEN from .env.' });
    next();
  });
  app.delete('/api/session', (req, res) => {
    res.clearCookie('switchboard', { path: '/api' });
    res.json({ ok: true });
  });
  const snapshot = () => ({
    accounts: store.state.accounts.map((account) => ({
      ...account,
      status: scheduler.accountStatus(account),
      loginCommand: `npm run account:login -- ${account.id}`,
    })),
    jobs: store.state.jobs
      .slice(-100)
      .reverse()
      .map(({ events, ...job }) => job),
    settings: {
      workspaceRoot: config.workspaceRoot,
      concurrency: config.concurrency,
      cooldownSeconds: config.cooldownMs / 1000,
      model: config.model,
      maxAttempts: config.maxAttempts,
    },
  });
  const accountById = (id) =>
    store.state.accounts.find((a) => a.id === id) ||
    fail('Account not found.', 404);
  const jobById = (id) =>
    store.state.jobs.find((j) => j.id === id) || fail('Job not found.', 404);
  app.get('/api/state', (req, res) => res.json(snapshot()));
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = () => res.write('event: change\ndata: {}\n\n');
    let pending;
    const listener = () => {
      if (!pending)
        pending = setTimeout(() => {
          pending = null;
          send();
        }, 250);
    };
    scheduler.on('change', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    send();
    req.on('close', () => {
      scheduler.off('change', listener);
      clearInterval(heartbeat);
      clearTimeout(pending);
    });
  });
  app.post('/api/accounts', (req, res) => {
    if (store.state.accounts.length >= 100) fail('Account limit reached.');
    const name = text(req.body.name, 60, 'account name');
    const apiKeyEnv = req.body.apiKeyEnv || null;
    if (
      apiKeyEnv &&
      (typeof apiKeyEnv !== 'string' ||
        !/^ACCOUNT_[A-Z0-9_]+_API_KEY$/.test(apiKeyEnv))
    )
      fail('Use an environment variable such as ACCOUNT_WORK_API_KEY.');
    if (
      store.state.accounts.some(
        (a) =>
          a.name.toLowerCase() === name.toLowerCase() ||
          (apiKeyEnv && a.apiKeyEnv === apiKeyEnv),
      )
    )
      fail('That account name or API key variable already exists.', 409);
    const account = {
      id: randomUUID(),
      name,
      apiKeyEnv,
      enabled: true,
      createdAt: new Date().toISOString(),
      cooldownUntil: 0,
    };
    mkdirSync(path.join(config.dataDir, 'accounts', account.id), {
      recursive: true,
      mode: 0o700,
    });
    store.state.accounts.push(account);
    scheduler.changed();
    scheduler.tick();
    res.status(201).json(account);
  });
  app.patch('/api/accounts/:id', (req, res) => {
    const account = accountById(req.params.id);
    if (typeof req.body.enabled !== 'boolean')
      fail('enabled must be a boolean.');
    account.enabled = req.body.enabled;
    scheduler.changed();
    scheduler.tick();
    res.json(account);
  });
  function jobInput(body) {
    const workspaceInput = text(body.workspace, 1000, 'workspace');
    let workspace, root;
    try {
      root = realpathSync(config.workspaceRoot);
      workspace = realpathSync(path.resolve(root, workspaceInput));
      if (!statSync(workspace).isDirectory())
        fail('Workspace must be a directory.');
    } catch {
      fail(
        'Workspace directory does not exist. Create it under WORKSPACE_ROOT first.',
      );
    }
    const relative = path.relative(root, workspace);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      fail('Workspace must stay inside WORKSPACE_ROOT.');
    if (overlaps(workspace, realpathSync(config.dataDir)))
      fail('Workspace must not contain or overlap the account data directory.');
    const sandbox = body.sandbox || 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox))
      fail('Invalid sandbox.');
    const model = body.model || config.model;
    if (
      typeof model !== 'string' ||
      model.length > 100 ||
      (model && !/^[a-zA-Z0-9._:-]+$/.test(model))
    )
      fail('Invalid model.');
    const accountId = body.accountId || null;
    if (accountId) accountById(accountId);
    for (const key of ['autoFailover', 'allowWriteRetry'])
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        fail(`${key} must be a boolean.`);
    return {
      prompt: text(body.prompt, 32000, 'prompt'),
      workspace,
      sandbox,
      model,
      accountId,
      autoFailover: body.autoFailover !== false,
      allowWriteRetry: body.allowWriteRetry === true,
    };
  }
  function checkQueueCapacity() {
    if (
      store.state.jobs.filter((j) =>
        ['queued', 'waiting', 'running'].includes(j.status),
      ).length >= 100
    )
      fail('Queue is full.', 409);
  }
  app.post('/api/jobs', (req, res) => {
    checkQueueCapacity();
    res.status(201).json(scheduler.submit(jobInput(req.body)));
  });
  app.get('/api/jobs/:id', (req, res) => res.json(jobById(req.params.id)));
  app.post('/api/jobs/:id/cancel', (req, res) => {
    scheduler.cancel(jobById(req.params.id));
    res.json({ ok: true });
  });
  app.post('/api/jobs/:id/retry', (req, res) => {
    checkQueueCapacity();
    const job = jobById(req.params.id);
    if (['queued', 'waiting', 'running'].includes(job.status))
      fail('Cancel the active job before retrying.', 409);
    res
      .status(201)
      .json(
        scheduler.submit(
          jobInput({ ...job, accountId: req.body.accountId ?? job.accountId }),
        ),
      );
  });
  app.use('/api', (req, res) =>
    res.status(404).json({ error: 'Endpoint not found.' }),
  );
  app.use(express.static(publicDir));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : 'Internal error. Check server logs.',
    });
    if (!error.status) console.error(error);
  });
  return app;
}
