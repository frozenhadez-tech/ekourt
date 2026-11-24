// Read-only smoke test against a RUNNING server (default http://localhost:4000).
// Signs in as the first Super Admin from .env and reads from each module. Creates no business records,
// so it is safe on production. The password is never printed.
//
//   npm run test:smoke
import { env } from '../server/env';

const base = (process.env.SMOKE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`) + '/api';
let cookie = '';
let failed = 0;

async function get(path: string) {
  const res = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
function check(name: string, pass: boolean, detail: string) {
  if (!pass) failed++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
}

const health = await get('/health');
check('database reachable', health.status === 200 && health.data?.ok, `${health.data?.database} · ${String(health.data?.version).slice(0, 15)} · Manila ${health.data?.manila_time}`);

check('API rejects anonymous access', (await get('/players')).status === 401, 'GET /players without a session → 401');

const login = await fetch(base + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ekourt' },
  body: JSON.stringify({ email: env.adminEmail, password: env.adminPassword }),
});
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
check('admin login', login.status === 200 && cookie.startsWith('ek_session='), `POST /auth/login → ${login.status}, HttpOnly session cookie ${cookie ? 'set' : 'missing'}`);

const me = await get('/auth/me');
check('session', me.status === 200, `${me.data?.user?.email ?? me.data?.email} (${me.data?.user?.role ?? me.data?.role})`);

const count = (d: any) => (Array.isArray(d) ? d.length : Array.isArray(d?.rows) ? d.rows.length : Array.isArray(d?.data) ? d.data.length : NaN);
for (const [name, path, min] of [
  ['courts', '/courts', 4], ['court rates', '/court-rates', 1], ['membership plans', '/membership-plans', 3],
  ['products', '/products', 8], ['services', '/services', 6], ['equipment', '/equipment', 3], ['discounts', '/discounts', 4],
  ['players', '/players', 0], ['reservations', '/reservations', 0], ['transactions', '/transactions', 0],
  ['expenses', '/expenses', 0], ['employees', '/employees', 1], ['audit log', '/audit-logs', 0], ['report list', '/reports', 21],
] as const) {
  const r = await get(path);
  const n = count(r.data);
  check(name, r.status === 200 && n >= min, `GET ${path} → ${r.status}, ${n} rows`);
}

const dash = await get('/dashboard');
check('dashboard', dash.status === 200, `GET /dashboard → ${dash.status}, keys: ${Object.keys(dash.data ?? {}).slice(0, 6).join(', ')}`);
const board = await get('/courts/board');
check('court board', board.status === 200, `GET /courts/board → ${board.status}`);
const settings = await get('/settings');
check('settings', settings.status === 200, `GET /settings → ${settings.status}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll smoke checks passed');
process.exit(failed ? 1 : 0);
