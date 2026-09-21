const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const labels = {
  needs_login: 'Needs login',
  needs_review: 'Needs review',
  ready: 'Ready',
  paused: 'Paused',
  cooldown: 'Cooling down',
  busy: 'Working',
  queued: 'Queued',
  waiting: 'Waiting',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  interrupted: 'Interrupted',
  limited: 'Limited',
};
const badge = (status) =>
  `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span>`;
const compact = (value) =>
  Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);
const activeStatuses = ['queued', 'waiting', 'running'];
let state = { accounts: [], jobs: [], settings: {} },
  stream,
  selectedJob,
  refreshPending = false,
  toastTimer,
  authenticated = false;
async function api(url, body, method = 'POST') {
  const response = await fetch(
    `/api${url}`,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (response.status === 401) showLogin();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 6000);
}
function showLogin() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  authenticated = false;
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  stream?.close();
  stream = null;
}
function relativeTime(value) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (!minutes) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString();
}
function tokensFor(accountId) {
  return state.jobs
    .flatMap((job) => job.attempts)
    .filter((attempt) => !accountId || attempt.accountId === accountId)
    .reduce(
      (sum, attempt) =>
        sum +
        (attempt.usage?.input_tokens || 0) +
        (attempt.usage?.output_tokens || 0),
      0,
    );
}
function accountCard(account) {
  const subtitle = account.apiKeyEnv
    ? 'API key · separate billing'
    : 'ChatGPT account';
  const cooldown =
    account.cooldownUntil > Date.now()
      ? `Retry in ~${Math.ceil((account.cooldownUntil - Date.now()) / 60000)}m`
      : 'Remaining quota unknown';
  return `<article class="account-card"><div class="account-card-top"><span class="avatar">${escapeHtml(account.name[0].toUpperCase())}</span><div><h3 class="account-name" title="${escapeHtml(account.name)}">${escapeHtml(account.name)}</h3><p class="muted small">${subtitle}</p></div>${badge(account.status)}</div><div class="account-metrics"><span>Subscription quota</span><strong>Not reported</strong></div><div class="quota-track" aria-hidden="true"></div><div class="account-bottom"><span>${compact(tokensFor(account.id))} tokens observed</span><span>${cooldown}</span></div><div class="account-actions">${account.apiKeyEnv ? `<button data-action="key-info" data-id="${account.id}">Setup info</button>` : `<button data-action="copy-login" data-id="${account.id}">Copy login command ↗</button>`}<button data-action="toggle-account" data-id="${account.id}">${account.enabled ? 'Pause' : 'Enable'}</button></div></article>`;
}
function accountsHtml(limit) {
  if (!state.accounts.length)
    return '<div class="empty-state"><span class="empty-symbol">◉</span><h3>A fresh start for your accounts</h3><p>Connect your first account to start running jobs.</p><button class="text-button" data-action="add-account">＋ Add your first account</button></div>';
  return state.accounts.slice(0, limit).map(accountCard).join('');
}
function jobsHtml(jobs) {
  if (!jobs.length)
    return '<div class="empty-state"><span class="empty-symbol">↗</span><h3>Your next idea starts here</h3><p>Create a job and follow its progress in real time.</p><button class="text-button" data-action="new-job">Create a job →</button></div>';
  return jobs
    .map(
      (job) =>
        `<button class="job-row" data-action="job-detail" data-id="${job.id}"><span class="job-symbol">${job.status === 'completed' ? '✓' : '⌘'}</span><div class="job-prompt">${escapeHtml(job.prompt)}<small>${escapeHtml(job.workspace.split(/[\\/]/).filter(Boolean).at(-1))} · ${job.sandbox === 'read-only' ? 'Read only' : 'Workspace edits'} · ${job.attempts.length} attempt${job.attempts.length === 1 ? '' : 's'}</small></div><span class="job-account">${escapeHtml(job.attempts.at(-1)?.accountName || 'Awaiting account')}</span>${badge(job.status)}<span class="job-time">${relativeTime(job.createdAt)}</span><span class="job-arrow">↗</span></button>`,
    )
    .join('');
}
function render() {
  const ready = state.accounts.filter((a) => a.status === 'ready').length;
  const running = state.jobs.filter((j) => j.status === 'running').length;
  const completed = state.jobs.filter((j) => j.status === 'completed').length;
  const waiting = state.jobs.filter((j) =>
    ['queued', 'waiting'].includes(j.status),
  ).length;
  $('#nav-account-count').textContent = state.accounts.length;
  $('#account-total').textContent = state.accounts.length;
  $('#stats').innerHTML = [
    [
      'Connected accounts',
      state.accounts.length,
      `<b>${ready} ready</b> to take a job`,
      '◉',
    ],
    [
      'Jobs running',
      running,
      `${state.settings.concurrency} concurrent slots · ${waiting} waiting`,
      '↗',
    ],
    ['Completed jobs', completed, 'In the latest 100 jobs', '✓'],
    [
      'Tokens observed',
      compact(tokensFor()),
      'Reported across recent attempts',
      '⌘',
    ],
  ]
    .map(
      ([label, value, foot, icon]) =>
        `<article class="stat"><div class="stat-label">${label}<span>${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`,
    )
    .join('');
  $('#overview-accounts').innerHTML = accountsHtml(3);
  $('#all-accounts').innerHTML = accountsHtml(100);
  $('#recent-jobs').innerHTML = jobsHtml(state.jobs.slice(0, 5));
  renderJobs();
  $('#workspace-hint').textContent =
    `Relative to ${state.settings.workspaceRoot}. The directory must already exist.`;
  const settings = [
    ['Project root', state.settings.workspaceRoot],
    ['Concurrent jobs', state.settings.concurrency],
    ['Account cooldown', `${state.settings.cooldownSeconds / 60} minutes`],
    ['Maximum attempts per job', state.settings.maxAttempts],
    ['Default model', state.settings.model || 'Codex default'],
    ['Authentication', 'Local dashboard token + isolated Codex logins'],
  ];
  $('#settings-list').innerHTML = settings
    .map(
      ([key, value]) =>
        `<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('');
}
function renderJobs() {
  const filter = $('#job-filter').value;
  $('#all-jobs').innerHTML = jobsHtml(
    state.jobs.filter(
      (j) =>
        filter === 'all' ||
        (filter === 'active' && activeStatuses.includes(j.status)) ||
        (filter === 'failed' &&
          ['failed', 'needs_review', 'interrupted'].includes(j.status)) ||
        j.status === filter,
    ),
  );
}
async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    state = await api('/state');
    authenticated = true;
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    render();
    if (selectedJob && $('#detail-dialog').open) await renderDetail();
    if (!stream) {
      stream = new EventSource('/api/events');
      stream.addEventListener('change', () => refresh().catch(() => {}));
      stream.onopen = () => {
        $('#connection-status').textContent = 'Live updates connected';
      };
      stream.onerror = () => {
        $('#connection-status').textContent = 'Reconnecting…';
      };
    }
  } finally {
    refreshPending = false;
  }
}
function navigate() {
  const requested = location.hash.slice(1),
    view = ['overview', 'accounts', 'activity', 'settings'].includes(requested)
      ? requested
      : 'overview';
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `${view}-view`;
  });
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
    if (el.dataset.view === view) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const content = {
    overview: [
      'Overview',
      'Keep the momentum.',
      'All your accounts and coding jobs, working together.',
    ],
    accounts: [
      'Accounts',
      'A little more capacity.',
      'Manage the accounts that keep your projects moving.',
    ],
    activity: [
      'Job activity',
      'Every run, in view.',
      'Track the queue, inspect output, and pick up where you left off.',
    ],
    settings: [
      'Configuration',
      'Make it your workspace.',
      'Your local setup, at a glance.',
    ],
  }[view];
  $('#page-name').textContent = content[0];
  $('#page-title').textContent = content[1];
  $('#page-subtitle').textContent = content[2];
}
function accountOptions(selected = '') {
  return `<option value="">Automatic · next available</option>${state.accounts.map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${escapeHtml(a.name)} · ${labels[a.status]}</option>`).join('')}`;
}
function newJob() {
  $('#job-account').innerHTML = accountOptions();
  $('#model').placeholder = state.settings.model || 'Use Codex default';
  $('#job-dialog').showModal();
}
async function renderDetail() {
  const id = selectedJob,
    job = await api(`/jobs/${id}`);
  if (selectedJob !== id || !$('#detail-dialog').open) return;
  // Preserve choices and scroll when live events refresh an open job.
  const retrySelection = $('#retry-account')?.value || '';
  const detailScroll = $('#detail-dialog').scrollTop;
  const running = activeStatuses.includes(job.status);
  const events = job.events
    .slice(-40)
    .reverse()
    .map(
      ({ at, event }) =>
        `<div class="event"><time>${new Date(at).toLocaleTimeString()}</time><b>${escapeHtml(event.type)}</b><details><summary>Event details</summary><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></details></div>`,
    )
    .join('');
  $('#job-detail').innerHTML =
    `${badge(job.status)}<p class="detail-prompt detail-section">${escapeHtml(job.prompt)}</p><p class="detail-meta">${escapeHtml(job.workspace)}<br>${job.sandbox === 'read-only' ? 'Read only' : 'Workspace edits'} · ${job.autoFailover ? 'Automatic failover enabled' : 'Failover disabled'} · ${escapeHtml(job.model || 'Codex default model')}<br>Created ${new Date(job.createdAt).toLocaleString()}</p>${job.status === 'waiting' ? '<div class="info-note">Waiting for an eligible account. Connect or enable an account, or let its cooldown finish. Jobs also wait while another job uses an overlapping directory.</div>' : ''}${job.error ? `<div class="info-note">${escapeHtml(job.error)}</div>` : ''}<div class="detail-actions">${running ? `<button class="secondary" data-action="cancel-job" data-id="${job.id}">Cancel job</button>` : `<select id="retry-account" aria-label="Account for retry">${accountOptions(retrySelection)}</select><button class="secondary" data-action="retry-job" data-id="${job.id}">Retry as a new job ↗</button>`}</div><div class="detail-section"><h3>Account attempts</h3>${job.attempts.length ? job.attempts.map((a, i) => `<div class="attempt"><span>${i + 1}.</span><strong>${escapeHtml(a.accountName)}</strong>${badge(a.status)}<small>${new Date(a.startedAt).toLocaleTimeString()}${a.usage ? ` · ${compact((a.usage.input_tokens || 0) + (a.usage.output_tokens || 0))} tokens` : ''}</small>${a.error ? `<p class="small error">${escapeHtml(a.error)}</p>` : ''}</div>`).join('') : '<p class="muted small">No attempt yet.</p>'}</div><div class="detail-section"><h3>Latest response</h3><pre class="output">${escapeHtml(job.output || 'The response will appear here when an attempt finishes.')}</pre></div><div class="detail-section"><h3>Live events <span class="muted small">most recent first</span></h3>${events || '<p class="muted small">Waiting for the first event…</p>'}</div>`;
  $('#detail-dialog').scrollTop = detailScroll;
}
async function action(name, id) {
  if (name === 'add-account') return $('#account-dialog').showModal();
  if (name === 'new-job') return newJob();
  const account = state.accounts.find((a) => a.id === id);
  if (name === 'copy-login') {
    await navigator.clipboard.writeText(account.loginCommand);
    return toast('Login command copied. Run it in a terminal in this project.');
  }
  if (name === 'key-info')
    return toast(`Set ${account.apiKeyEnv} in .env and restart the server.`);
  if (name === 'toggle-account') {
    await api(`/accounts/${id}`, { enabled: !account.enabled }, 'PATCH');
    await refresh();
    return;
  }
  if (name === 'job-detail') {
    selectedJob = id;
    $('#job-detail').textContent = 'Loading job…';
    $('#detail-dialog').showModal();
    return renderDetail();
  }
  if (name === 'cancel-job') {
    await api(`/jobs/${id}/cancel`, {});
    await refresh();
    return toast('Cancellation requested.');
  }
  if (name === 'retry-job') {
    const job = await api(`/jobs/${id}/retry`, {
      accountId: $('#retry-account').value,
    });
    selectedJob = job.id;
    await refresh();
    return toast('New attempt queued.');
  }
}
document.addEventListener('click', async (event) => {
  const close = event.target.closest('[data-close]');
  if (close) {
    $(`#${close.dataset.close}`).close();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    await action(button.dataset.action, button.dataset.id);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/session', { token: $('#token').value });
    $('#token').value = '';
    await refresh();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('#logout').addEventListener('click', async () => {
  try {
    await api('/session', {}, 'DELETE');
    showLogin();
  } catch (error) {
    toast(error.message);
  }
});
$('#account-type').addEventListener('change', () => {
  const isApi = $('#account-type').value === 'api';
  $('#api-key-field').hidden = !isApi;
  $('#api-key-env').required = isApi;
  $('#chatgpt-help').hidden = isApi;
});
$('#sandbox').addEventListener('change', () => {
  $('#write-retry-field').hidden = $('#sandbox').value !== 'workspace-write';
});
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/accounts', {
      name: form.elements.name.value,
      apiKeyEnv:
        form.elements.type.value === 'api'
          ? form.elements.apiKeyEnv.value
          : null,
    });
    $('#account-dialog').close();
    form.reset();
    $('#account-type').dispatchEvent(new Event('change'));
    await refresh();
    toast('Account added. Complete its login to make it available.');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$('#job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('button[type=submit]');
  button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  data.autoFailover = form.elements.autoFailover.checked;
  data.allowWriteRetry =
    data.sandbox === 'workspace-write' && form.elements.allowWriteRetry.checked;
  try {
    const job = await api('/jobs', data);
    $('#job-dialog').close();
    form.elements.prompt.value = '';
    await refresh();
    toast('Job queued.');
    await action('job-detail', job.id);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$('#detail-dialog').addEventListener('close', () => {
  selectedJob = null;
});
$('#job-filter').addEventListener('change', renderJobs);
window.addEventListener('hashchange', navigate);
navigate();
refresh().catch((error) => {
  if (authenticated) toast(error.message);
});
setInterval(() => {
  if (authenticated && !document.hidden)
    refresh().catch(() => {
      $('#connection-status').textContent = 'Connection interrupted';
    });
}, 5000);
