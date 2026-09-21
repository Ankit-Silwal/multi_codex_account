# Codex Switchboard

A local Node.js + Express dashboard for running Codex jobs across multiple accounts. Each account has its own login directory. Jobs can run concurrently in different project directories, and eligible jobs automatically retry with another account when Codex reports a usage or rate limit.

## Get started

Requires **Node.js 22.13+**, npm, and accounts with access to Codex. The official Codex CLI is installed as a pinned project dependency; a global installation is unnecessary.

```sh
npm ci
npm run setup
npm start
```

Open **http://127.0.0.1:3210**. Sign in using `ADMIN_TOKEN` from the generated `.env`. Setup generates a random token and never overwrites an existing `.env`.

### Connect ChatGPT accounts

1. Click **Add account**, give it a name, and choose **Sign in with ChatGPT**.
2. Click **Copy login command** on its card.
3. Run that command in a terminal in this project:

   ```sh
   npm run account:login -- ACCOUNT_ID
   ```

4. Complete the official sign-in flow using the intended account. Repeat for each account. If your browser keeps selecting the same account, sign out of that browser session or use another browser profile before completing the next login.
5. The dashboard detects the account's credential file automatically.

For a supported device-code login instead:

```sh
npm run account:login -- ACCOUNT_ID --device
```

Each login uses `data/accounts/<id>` as its `CODEX_HOME`, with file-based credential storage. Your usual Codex home and existing desktop/IDE login are not modified. Account names are labels, not verified identities: make sure you sign into distinct accounts if you want distinct quota pools.

### Connect API accounts (optional)

Add keys to `.env` yourself:

```dotenv
ACCOUNT_PERSONAL_API_KEY=your-first-key
ACCOUNT_WORK_API_KEY=your-second-key
```

Restart the server. Add an account with **API key from .env**, supplying the **variable name**, such as `ACCOUNT_WORK_API_KEY`. Never paste the key into the account-name or variable-name fields. Only names matching `ACCOUNT_*_API_KEY` are accepted.

API usage is billed separately from a ChatGPT subscription. Multiple keys in the same API project may share limits; adding keys does not create independent capacity. You must have permission to use each configured account and its available quota.

## Run jobs

Put projects inside `workspaces/`, or set `WORKSPACE_ROOT` in `.env` to an existing parent folder containing your projects. The job's directory must exist and resolve inside that root. It cannot overlap the directory containing account data.

For example, with `WORKSPACE_ROOT=C:/Studies/Web Development`, enter `my-project` as the job directory. Choose a specific project folder rather than the common parent.

- **Automatic account selection** chooses the least recently used available account.
- **Starting account** prefers your selected account for the first attempt. It waits if that account is busy, paused, disconnected, or cooling down.
- **Automatic failover** retries a quota-limited job on another eligible account. Authentication failures, ordinary tool errors, and timeouts do not rotate accounts.
- **Concurrent jobs** use different accounts and non-overlapping directories, up to the configured limit. Each account runs one job at a time. Jobs sharing a directory, including parent/child directories, are serialized.
- **Read only** is the default Codex sandbox. Select **Allow workspace edits** for coding tasks.
- **Automatic retries of write-enabled jobs** are opt-in because interrupted attempts can already have modified files or executed commands. Otherwise quota exhaustion pauses the job for review. Use the retry account selector after inspecting the workspace.
- **Cancellation** stops a queued job or requests termination of its running CLI process tree. It does not undo completed actions.

Retries start a **new Codex session** with the original prompt and a reminder to inspect existing work. They do not move the original conversation or resume it seamlessly on another account. The app only switches accounts for jobs it starts, not for an existing desktop or IDE session.

If every account is unavailable, the job waits. Quota errors set a configurable local cooldown. Expiration allows a new attempt; it is **not** a confirmed provider reset time. Attempts stop at `MAX_JOB_ATTEMPTS`. Token totals are observed CLI usage from the latest 100 jobs, not remaining plan credits. Missing usage is not estimated.

## Configuration

See [`.env.example`](.env.example). Restart after editing `.env`.

| Variable                   | Default            | Purpose                                                       |
| -------------------------- | ------------------ | ------------------------------------------------------------- |
| `HOST`                     | `127.0.0.1`        | Loopback only: `127.0.0.1`, `localhost`, or `::1`             |
| `PORT`                     | `3210`             | Dashboard port                                                |
| `ADMIN_TOKEN`              | Generated by setup | Dashboard password / API bearer token; at least 24 characters |
| `DATA_DIR`                 | `./data`           | Persistent state and account credentials                      |
| `WORKSPACE_ROOT`           | `./workspaces`     | Allowed project parent directory                              |
| `MAX_CONCURRENT_JOBS`      | `3`                | Maximum parallel jobs (1–20)                                  |
| `ACCOUNT_COOLDOWN_SECONDS` | `3600`             | Local retry delay after a quota error                         |
| `JOB_TIMEOUT_SECONDS`      | `1800`             | Maximum duration of each attempt                              |
| `MAX_JOB_ATTEMPTS`         | `5`                | Attempt budget for one job                                    |
| `CODEX_MODEL`              | Empty              | Optional model override; empty uses Codex's default           |

No GitHub token is needed to run the platform. Git pushes during development use your existing Git credentials. The dashboard itself does not automatically commit or publish changes made by jobs.

## Storage and operating model

This is a **single-user local application**, not a hosted multi-tenant service. One server owns each `DATA_DIR`; a process lock prevents concurrent writers. State is written through a temporary file and atomic rename. On restart, running jobs become `interrupted` and require a deliberate retry; queued jobs continue. Job events are bounded to the latest 150 per job and oversized event payloads are truncated. History remains on disk until you archive it yourself.

The server binds only to loopback. The UI uses an HttpOnly, SameSite cookie; programmatic clients can use `Authorization: Bearer <ADMIN_TOKEN>`. Cross-origin API requests are rejected. The child CLI gets an allowlisted environment containing only its selected account key, not the dashboard token or other account keys. Workspace paths are resolved before containment checks, and process arguments are passed without a shell.

`data/` contains plaintext Codex credential files, prompts, and model output. `.env` contains secrets. Both are Git-ignored and should be protected with your OS permissions. Separate Codex homes isolate login state, not OS users or files: Codex's own sandbox still governs file access. Use trusted repositories and prompts. Prompt output can include sensitive project content; common API keys and bearer tokens are redacted, but this is not a general data-loss prevention system.

Keep account data outside job workspaces. Back up `DATA_DIR` only to a private location while the server is stopped. If you change `DATA_DIR` or `WORKSPACE_ROOT` to an in-repository path, add that path to `.gitignore` before committing. Do not run two servers against the same directory. A stale lock from a dead process is recovered automatically; a malformed lock requires manual inspection.

Windows uses a hidden `taskkill /T` process for cancellation, and Unix uses a process group. Use an account with permission to stop its own child processes. Codex sandbox availability and platform requirements still apply. The dashboard never enables the Codex sandbox-bypass flag.

## HTTP API

All routes except `POST /api/session` require the dashboard cookie or bearer token. JSON request bodies are capped at 64 KB.

| Method        | Path                   | Action                                                                 |
| ------------- | ---------------------- | ---------------------------------------------------------------------- |
| POST / DELETE | `/api/session`         | Sign in with `{ "token": "..." }` / sign out                           |
| GET           | `/api/state`           | Accounts, latest 100 jobs, public settings                             |
| GET           | `/api/events`          | Server-sent change notifications                                       |
| POST          | `/api/accounts`        | Create `{ "name": "Work", "apiKeyEnv": null }`                         |
| PATCH         | `/api/accounts/:id`    | Pause/enable with `{ "enabled": false }`                               |
| POST          | `/api/jobs`            | Submit prompt, workspace, sandbox, account and retry settings          |
| GET           | `/api/jobs/:id`        | Full job, attempts, latest output and bounded events                   |
| POST          | `/api/jobs/:id/cancel` | Cancel job                                                             |
| POST          | `/api/jobs/:id/retry`  | Create a fresh job; optional `accountId`, empty string means automatic |

Example job body:

```json
{
  "prompt": "Review the code and summarize possible improvements.",
  "workspace": "my-project",
  "sandbox": "read-only",
  "accountId": "",
  "autoFailover": true,
  "allowWriteRetry": false
}
```

## Development and verification

```sh
npm run dev
npm test
npm run check
npm run format:check
npx playwright install chromium
npm run test:e2e
```

To use an installed Chrome browser on Windows instead of downloading Chromium:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:e2e
```

Tests use temporary data and deterministic fake Codex processes. They check scheduler failover and concurrency, authentication and path restrictions, crash recovery, CLI JSONL parsing, timeout/cancellation, desktop flows and mobile layout. They do not consume API credits or sign in to real accounts. Browser screenshots and traces are saved in ignored `test-results/`. Real account sign-in and a billable job still require your credentials and are not covered by these simulated checks.

Official implementation references: [Codex authentication and credential storage](https://developers.openai.com/codex/auth/) and [non-interactive CLI jobs and JSON events](https://developers.openai.com/codex/noninteractive/).

## Milestones

1. Isolated accounts, Express API, persistent scheduler, quota failover and backend tests.
2. Responsive dashboard, account setup, live jobs, attempt history and browser verification.
3. Process robustness, setup documentation, formatting and CI validation.
