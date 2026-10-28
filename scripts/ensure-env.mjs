// Creates .env from .env.example on first `pnpm dev`, with a fresh AES key.
// Never overwrites an existing .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const envPath = new URL('../.env', import.meta.url);
const examplePath = new URL('../.env.example', import.meta.url);

if (!existsSync(envPath)) {
  const key = randomBytes(32).toString('hex');
  const text = readFileSync(examplePath, 'utf8').replace(/^DEMO_AES_KEY=.*$/m, `DEMO_AES_KEY=${key}`);
  writeFileSync(envPath, text);
  console.log('[ensure-env] created .env with a freshly generated DEMO_AES_KEY');
}
