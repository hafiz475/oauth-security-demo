import { randomBytes } from 'node:crypto';

// A fresh key per test run; nothing secret is committed to the repo.
process.env.DEMO_AES_KEY ??= randomBytes(32).toString('hex');
process.env.LOG_LEVEL ??= 'silent';
