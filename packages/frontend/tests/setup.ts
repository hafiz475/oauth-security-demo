import { randomBytes } from 'node:crypto';

// no-token-in-browser boots the real backend in-process; it needs a key.
process.env.DEMO_AES_KEY ??= randomBytes(32).toString('hex');
process.env.LOG_LEVEL ??= 'silent';
