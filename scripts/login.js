import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { accountEnv, codexCommand } from '../src/runner.js';
const config = getConfig();
const state = JSON.parse(readFileSync(path.join(config.dataDir, 'state.json'), 'utf8'));
const account = state.accounts.find(a => a.id === process.argv[2]);
if (!account) { console.error('Copy the login command from an account card in the dashboard.'); process.exit(1); }
if (account.apiKeyEnv) { console.error(`Set ${account.apiKeyEnv} in .env and restart the server instead.`); process.exit(1); }
const command = codexCommand();
console.log(`Signing in to ${account.name}. Choose the intended account in the browser.`);
const args = [...command.prefix, 'login', '--config', 'cli_auth_credentials_store="file"'];
if (process.argv.includes('--device')) args.push('--device-auth');
const child = spawn(command.file, args, { env: accountEnv(account, config.dataDir), stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
