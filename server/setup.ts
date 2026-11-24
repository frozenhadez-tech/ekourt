// Generates local secrets in .env (never committed). Safe to re-run: existing values are kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './env';

const file = path.join(rootDir, '.env');
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const has = (key: string) => new RegExp(`^${key}=.+`, 'm').test(text);
const added: string[] = [];

function ensure(key: string, value: string) {
  if (has(key)) return;
  text = text.replace(new RegExp(`^${key}=.*\\r?\\n?`, 'm'), '');
  if (text && !text.endsWith('\n')) text += '\n';
  text += `${key}=${value}\n`;
  added.push(key);
}

ensure('JWT_SECRET', crypto.randomBytes(48).toString('hex'));
ensure('ADMIN_EMAIL', 'admin@ekourt.local');
ensure('ADMIN_PASSWORD', crypto.randomBytes(9).toString('base64url'));

fs.writeFileSync(file, text);
console.log(added.length ? `Wrote ${added.join(', ')} to .env` : '.env already complete');
console.log('The first Super Admin login uses ADMIN_EMAIL / ADMIN_PASSWORD from .env. Change the password after signing in.');
