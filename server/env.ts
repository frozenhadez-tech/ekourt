import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env.local (written by `neon env pull` / `neon deploy`) wins over .env
dotenv.config({ path: [path.join(rootDir, '.env.local'), path.join(rootDir, '.env')], quiet: true });

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  // Pooled URL for the app; direct (unpooled) URL for migrations when available.
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseUrlDirect: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@ekourt.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
};

export function assertEnv() {
  const missing: string[] = [];
  if (!env.databaseUrl) missing.push('DATABASE_URL (run `neon env pull` or set it in .env)');
  if (env.jwtSecret.length < 32) missing.push('JWT_SECRET (run `npm run setup` to generate one)');
  if (missing.length) {
    console.error('Missing configuration:\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
}
