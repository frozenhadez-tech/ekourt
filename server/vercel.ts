// Vercel entry point. `npm run build:api` bundles this file into api/index.js, which Vercel runs as
// one serverless function for every /api/* and /uploads/* request (see vercel.json).
// The long-running server in index.ts is not used there.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app';
import { env } from './env';
import { migrate } from './migrate';
import { runMaintenance } from './routes/system';

const app = createApp();
let ready: Promise<void> | undefined;
let lastMaintenance = 0;

async function init() {
  if (!env.databaseUrl) throw new Error('DATABASE_URL is not set in the Vercel project');
  if (env.jwtSecret.length < 32) throw new Error('JWT_SECRET is not set in the Vercel project (32+ characters)');
  await migrate(); // once per cold start; a no-op when the schema is current
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await (ready ??= init());
  } catch (err) {
    ready = undefined;
    console.error('[api] startup failed:', (err as Error).message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The server is not configured correctly. Check the deployment logs.' }));
    return;
  }
  // Replaces the hourly timer of the long-running server.
  if (Date.now() - lastMaintenance > 60 * 60 * 1000) {
    lastMaintenance = Date.now();
    await runMaintenance().catch((e) => console.error('[maintenance]', e.message));
  }
  return app(req as any, res as any);
}
