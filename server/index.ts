import { createApp } from './app';
import { pool } from './db';
import { assertEnv, env } from './env';
import { migrate } from './migrate';
import { runMaintenance } from './routes/system';

assertEnv();

async function main() {
  await migrate();
  await runMaintenance().catch((e) => console.error('[maintenance]', e.message));
  setInterval(() => runMaintenance().catch((e) => console.error('[maintenance]', e.message)), 60 * 60 * 1000).unref();

  const server = createApp().listen(env.port, () => {
    console.log(`[api] E-Kourt API listening on http://localhost:${env.port} (${env.isProd ? 'production' : 'development'})`);
  });
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[api] failed to start:', err.message);
  process.exit(1);
});
