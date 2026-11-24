// Applies db/migrations/*.sql in order, once each, and creates the first Super Admin.
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertEnv, env, rootDir } from './env';

export async function migrate(log: (m: string) => void = console.log) {
  const client = new pg.Client({ connectionString: env.databaseUrlDirect });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    // One migrator at a time, even if two servers boot together.
    await client.query('select pg_advisory_lock(727274)');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const dir = path.join(rootDir, 'db', 'migrations');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    const { rows } = await client.query('select count(*)::int as n from employees');
    if (rows[0].n === 0) {
      if (!env.adminPassword) throw new Error('No employees exist and ADMIN_PASSWORD is not set. Run `npm run setup` first.');
      const hash = await bcrypt.hash(env.adminPassword, 12);
      await client.query(
        `insert into employees (employee_no, full_name, email, password_hash, role, position)
         values ('EMP-0001', 'System Administrator', $1, $2, 'super_admin', 'Owner')`,
        [env.adminEmail.toLowerCase(), hash],
      );
      log(`[migrate] created Super Admin ${env.adminEmail} (password = ADMIN_PASSWORD in .env)`);
    }
    await client.query('select pg_advisory_unlock(727274)');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertEnv();
  migrate().then(() => console.log('[migrate] database is up to date')).catch((e) => { console.error(e.message); process.exit(1); });
}
