import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  writeFileSync(
    '.env',
    readFileSync('.env', 'utf8').replace(
      'replace-with-a-long-random-token-at-least-24-characters',
      randomBytes(32).toString('hex'),
    ),
    { mode: 0o600 },
  );
  console.log(
    'Created .env with a random dashboard token. Keep this file private.',
  );
} else console.log('.env already exists; preserved your settings.');
mkdirSync('workspaces', { recursive: true });
console.log(
  'Put projects under workspaces/ or set WORKSPACE_ROOT in .env, then run npm start.',
);
