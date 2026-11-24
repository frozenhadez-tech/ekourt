// End-to-end API test of the reservation, POS, shift, membership, inventory and refund workflows.
// Boots the real Express app against the database in DATABASE_URL and drives it over HTTP.
//
//   npm run test:api
//
// It writes test records (players, reservations, transactions) that cannot be deleted afterwards by design,
// so run it against a Neon development branch, not production. Set ALLOW_TEST_ON_THIS_DB=1 to confirm.
import bcrypt from 'bcryptjs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { pool } from '../server/db';
import { assertEnv, env } from '../server/env';
import { migrate } from '../server/migrate';

assertEnv();
if (process.env.ALLOW_TEST_ON_THIS_DB !== '1') {
  console.error('Refusing to run: set ALLOW_TEST_ON_THIS_DB=1 and point DATABASE_URL at a development branch.');
  process.exit(1);
}

let base = '';
let passed = 0;
const failures: string[] = [];
const run = Date.now().toString(36);

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ekourt', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, data: (await res.json().catch(() => null)) as any };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  if (String(actual) !== String(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
function ok(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}
const key = () => `test-${run}-${Math.random().toString(36).slice(2)}`;

async function main() {
  await migrate(() => {});
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  // Test accounts for each role (password is random per run and never printed).
  const pw = `T-${run}-${Math.random().toString(36).slice(2)}`;
  const hash = await bcrypt.hash(pw, 10);
  const mk = async (role: string) => {
    const email = `${role}.${run}@test.ekourt.local`;
    await pool.query(`insert into employees (employee_no, full_name, email, password_hash, role) values ($1,$2,$3,$4,$5)`, [`T-${role.slice(0, 3)}-${run}`, `Test ${role}`, email, hash, role]);
    const c = new Client();
    const r = await c.post('/auth/login', { email, password: pw });
    eq(r.status, 200, `login as ${role}`);
    return { c, email };
  };
  const { c: admin } = await mk('super_admin');
  const { c: cashier } = await mk('cashier');
  const { c: recep } = await mk('receptionist');
  const { email: managerEmail } = await mk('manager');

  // Fixtures looked up from seeded data.
  const courts = (await admin.get('/courts')).data;
  const products = (await admin.get('/products')).data;
  const services = (await admin.get('/services')).data;
  const equipment = (await admin.get('/equipment')).data;
  const plans = (await admin.get('/membership-plans')).data;
  const discounts = (await admin.get('/discounts')).data;
  const water = products.find((p: any) => p.code === 'PRD-0001');
  const paddle = equipment.find((e: any) => e.code === 'EQ-PADDLE');
  const premium = plans.find((p: any) => p.code === 'PREMIUM');
  const vip = plans.find((p: any) => p.code === 'VIP');

  // A weekday far enough ahead to be empty, unique per run so reruns do not collide.
  const dayInfo = (await pool.query(`select to_char(d, 'YYYY-MM-DD') as date from generate_series(manila_today() + 20, manila_today() + 400, interval '1 day') d
     where extract(dow from d) between 1 and 5 and not exists (select 1 from reservations r where manila_date(r.start_at) = d::date)
       and not exists (select 1 from holidays h where h.holiday_date = d::date) limit 1`)).rows[0];
  const date = dayInfo.date as string;
  eq((await admin.put('/settings', { max_advance_booking_days: 365, vat_registered: false, require_open_shift: true })).status, 200, 'test settings');

  console.log('\nAuthentication & permissions');
  await test('rejects a wrong password', async () => eq((await new Client().post('/auth/login', { email: managerEmail, password: 'wrong-password' })).status, 401, 'status'));
  await test('rejects unauthenticated API access', async () => eq((await new Client().get('/players')).status, 401, 'status'));
  await test('rejects writes without the CSRF header', async () => {
    const res = await fetch(base + '/players', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: '{}' });
    eq(res.status, 403, 'status');
  });
  await test('receptionist cannot use the POS (server-side check)', async () => eq((await recep.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'product', ref_id: water.id }], payments: [] })).status, 403, 'status'));
  await test('cashier cannot change prices or create employees', async () => {
    eq((await cashier.put(`/products/${water.id}`, { selling_price: '1.00' })).status, 403, 'product price');
    eq((await cashier.post('/employees', { full_name: 'x', email: `x${run}@x.io`, role: 'admin', password: 'password123' })).status, 403, 'employee');
    eq((await cashier.put('/settings', { vat_rate: 1 })).status, 403, 'settings');
  });

  console.log('\nPlayers');
  let player: any;
  await test('registers a player with an EK-000000 ID', async () => {
    const r = await recep.post('/players', { full_name: `Juan Dela Cruz ${run}`, contact_number: `09${run.slice(-9).padStart(9, '0')}`, email: `juan.${run}@example.com` });
    eq(r.status, 201, 'status');
    ok(/^EK-\d{6}$/.test(r.data.player_no), `player_no format: ${r.data.player_no}`);
    player = r.data;
  });
  await test('blocks duplicate email and contact number', async () => {
    eq((await recep.post('/players', { full_name: 'Dup', email: `JUAN.${run}@example.com` })).status, 409, 'email');
    eq((await recep.post('/players', { full_name: 'Dup', contact_number: player.contact_number })).status, 409, 'contact');
  });

  console.log('\nPricing');
  await test('weekday 1h = 300, 2h = 550, 3h = 800, 4h = 1100 (cheapest combination)', async () => {
    for (const [h, price] of [[1, '300.00'], [2, '550.00'], [3, '800.00'], [4, '1100.00']] as const) {
      const q = await recep.post('/reservations/quote', { court_id: courts[0].id, date, start_time: '08:00', duration_hours: h });
      eq(q.data.rate_amount, price, `${h}h`);
    }
  });

  console.log('\nReservations');
  let pending: any;
  await test('receptionist creates a pending reservation (EKB-YYYY-000000)', async () => {
    const r = await recep.post('/reservations', { court_id: courts[0].id, date, start_time: '08:00', duration_hours: 2, player_id: player.id });
    eq(r.status, 201, 'status');
    ok(/^EKB-\d{4}-\d{6}$/.test(r.data.reservation.reference_no), 'reference format');
    eq(r.data.reservation.status, 'pending', 'status');
    eq(r.data.reservation.total_amount, '550.00', 'total');
    eq(r.data.reservation.end_time, '10:00', 'end time');
    pending = r.data.reservation;
  });
  await test('rejects an overlapping booking on the same court', async () => {
    eq((await recep.post('/reservations', { court_id: courts[0].id, date, start_time: '09:00', duration_hours: 1, customer_name: 'Overlap' })).status, 409, 'status');
  });
  await test('allows a back-to-back booking and the same time on another court', async () => {
    eq((await recep.post('/reservations', { court_id: courts[0].id, date, start_time: '10:00', duration_hours: 1, customer_name: 'Back to back' })).status, 201, 'adjacent');
    eq((await recep.post('/reservations', { court_id: courts[1].id, date, start_time: '08:00', duration_hours: 2, player_id: player.id })).status, 201, 'other court');
  });
  await test('10 simultaneous requests for one slot: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => recep.post('/reservations', { court_id: courts[2].id, date, start_time: '15:00', duration_hours: 1, customer_name: `Racer ${i}` })));
    eq(results.filter((r) => r.status === 201).length, 1, 'winners');
    eq(results.filter((r) => r.status === 409).length, 9, 'conflicts');
  });
  await test('the database constraint itself blocks a double booking (bypassing the API)', async () => {
    const err = await pool.query(
      `insert into reservations (reference_no, customer_name, court_id, start_at, end_at, duration_hours, status)
       select 'RAW-' || $1, 'raw', court_id, start_at, end_at, duration_hours, 'confirmed' from reservations where id = $2`, [run, pending.id]).then(() => null, (e) => e);
    eq(err?.code, '23P01', 'exclusion violation code');
  });
  await test('rejects bookings outside operating hours and in the past', async () => {
    eq((await recep.post('/reservations', { court_id: courts[3].id, date, start_time: '21:00', duration_hours: 2, customer_name: 'Late' })).status, 400, 'after close');
    eq((await recep.post('/reservations', { court_id: courts[3].id, date: '2020-01-06', start_time: '10:00', duration_hours: 1, customer_name: 'Past' })).status, 400, 'past');
  });
  await test('reschedules an unbilled reservation and re-checks conflicts', async () => {
    eq((await recep.put(`/reservations/${pending.id}/reschedule`, { court_id: courts[1].id, date, start_time: '09:00', duration_hours: 2 })).status, 409, 'conflict');
    const r = await recep.put(`/reservations/${pending.id}/reschedule`, { court_id: courts[0].id, date, start_time: '12:00', duration_hours: 2 });
    eq(r.status, 200, 'status');
    eq(r.data.start_time, '12:00', 'new time');
  });

  console.log('\nCashier shift');
  await test('checkout is refused until a shift is open', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'product', ref_id: water.id }], payments: [{ method: 'cash', amount: '25' }] });
    eq(r.status, 409, 'status');
    eq(r.data.code, 'NO_SHIFT', 'code');
  });
  let shift: any;
  await test('opens a shift with an opening cash fund; a second open is refused', async () => {
    const r = await cashier.post('/shifts/open', { opening_cash: '1000' });
    eq(r.status, 201, 'status');
    shift = r.data;
    eq((await cashier.post('/shifts/open', { opening_cash: '1' })).status, 409, 'second open');
  });

  console.log('\nPOS checkout');
  const stockBefore = (await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty;
  let sale: any;
  await test('product + service sale, cash with change, EKT-YYYY-000000', async () => {
    const r = await cashier.post('/transactions/checkout', {
      idempotency_key: key(), customer_name: 'Walk-in Maria',
      items: [{ item_type: 'product', ref_id: water.id, quantity: 3 }, { item_type: 'service', ref_id: services.find((s: any) => s.code === 'SVC-PARK').id }],
      payments: [{ method: 'cash', amount: '100' }],
    });
    eq(r.status, 201, 'status');
    ok(/^EKT-\d{4}-\d{6}$/.test(r.data.transaction_no), 'transaction no format');
    eq(r.data.total, '95.00', 'total');
    eq(r.data.change_due, '5.00', 'change');
    eq(r.data.status, 'completed', 'status');
    eq(r.data.payments[0].amount, '95.00', 'applied');
    eq(r.data.payments[0].tendered, '100.00', 'tendered');
    sale = r.data;
  });
  await test('inventory is deducted and a sale movement is written', async () => {
    eq((await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty, stockBefore - 3, 'stock');
    const mv = (await admin.get(`/inventory/movements?product_id=${water.id}`)).data[0];
    eq(mv.movement_type, 'sale', 'movement type');
    eq(mv.quantity, -3, 'movement qty');
  });
  await test('client-supplied prices are ignored', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'product', ref_id: water.id, unit_price: '0.01', price: '0.01' }], payments: [{ method: 'cash', amount: '25' }] });
    eq(r.data.total, '25.00', 'total');
  });
  await test('the same idempotency key never creates a second transaction (sequential and concurrent)', async () => {
    const k = key();
    const body = { idempotency_key: k, items: [{ item_type: 'product', ref_id: water.id }], payments: [{ method: 'gcash', amount: '25', reference_no: 'GC123' }] };
    const before = (await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty;
    const results = await Promise.all(Array.from({ length: 5 }, () => cashier.post('/transactions/checkout', body)));
    const again = await cashier.post('/transactions/checkout', body);
    const ids = new Set([...results, again].map((r) => r.data?.id));
    eq(ids.size, 1, 'distinct transaction ids');
    eq((await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty, before - 1, 'stock deducted once');
  });
  await test('underpayment is refused unless a partial payment is allowed', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'product', ref_id: water.id }], payments: [{ method: 'cash', amount: '10' }] });
    eq(r.status, 400, 'status');
    eq(r.data.code, 'UNDERPAID', 'code');
  });
  await test('overselling is impossible: 2 tills race for more stock than exists', async () => {
    const p = (await admin.post('/products', { code: `T-${run}`, name: `Scarce ${run}`, cost_price: '1', selling_price: '10' })).data;
    await admin.post('/inventory/movements', { product_id: p.id, movement_type: 'stock_in', quantity: 3 });
    const results = await Promise.all(Array.from({ length: 6 }, () => cashier.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'product', ref_id: p.id }], payments: [{ method: 'cash', amount: '10' }] })));
    eq(results.filter((r) => r.status === 201).length, 3, 'successful sales');
    eq((await admin.get('/products')).data.find((x: any) => x.id === p.id).stock_qty, 0, 'final stock');
  });
  await test('split payment across cash + GCash + Maya', async () => {
    const r = await cashier.post('/transactions/checkout', {
      idempotency_key: key(), items: [{ item_type: 'service', ref_id: services.find((s: any) => s.code === 'SVC-COACH').id }],
      payments: [{ method: 'gcash', amount: '200', reference_no: 'G1' }, { method: 'maya', amount: '100', reference_no: 'M1' }, { method: 'cash', amount: '500' }],
    });
    eq(r.status, 201, 'status');
    eq(r.data.payments.length, 3, 'payment rows');
    eq(r.data.change_due, '300.00', 'change');
    eq(r.data.transaction_type, 'coaching', 'type');
  });

  console.log('\nReservation payment: deposit, balance, check-in');
  let resTrx: any;
  await test('pays a deposit on the pending reservation: partial, balance retained, reservation confirmed', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), player_id: player.id, allow_partial: true, items: [{ item_type: 'court', ref_id: pending.id }], payments: [{ method: 'gcash', amount: '200', reference_no: 'DEP1' }] });
    eq(r.status, 201, 'status');
    eq(r.data.status, 'partial', 'status');
    eq(r.data.balance, '350.00', 'balance');
    eq(r.data.payments[0].kind, 'deposit', 'kind');
    resTrx = r.data;
    const res = (await recep.get(`/reservations/${pending.id}`)).data;
    eq(res.status, 'confirmed', 'reservation status');
    eq(res.amount_paid, '200.00', 'reservation paid');
  });
  await test('a reservation cannot be billed twice', async () => {
    eq((await cashier.post('/transactions/checkout', { idempotency_key: key(), player_id: player.id, items: [{ item_type: 'court', ref_id: pending.id }], payments: [{ method: 'cash', amount: '550' }] })).status, 409, 'status');
  });
  await test('collects the balance: transaction completed, no duplicate on retry', async () => {
    const k = key();
    const r = await cashier.post(`/transactions/${resTrx.id}/payments`, { idempotency_key: k, payments: [{ method: 'cash', amount: '500' }] });
    eq(r.status, 201, 'status');
    eq(r.data.status, 'completed', 'status');
    eq(r.data.balance, '0.00', 'balance');
    eq(r.data.amount_paid, '550.00', 'paid');
    const retry = await cashier.post(`/transactions/${resTrx.id}/payments`, { idempotency_key: k, payments: [{ method: 'cash', amount: '500' }] });
    eq(retry.data.payments.length, 2, 'payment rows after retry');
  });
  await test('status flow: check in → in progress → completed; invalid jumps refused', async () => {
    eq((await recep.post(`/reservations/${pending.id}/status`, { status: 'completed' })).status, 409, 'confirmed → completed');
    for (const s of ['checked_in', 'in_progress', 'completed']) eq((await recep.post(`/reservations/${pending.id}/status`, { status: s })).data.status, s, s);
  });
  await test('book-and-pay-in-full in one step from the reservation screen', async () => {
    const r = await cashier.post('/reservations', { court_id: courts[3].id, date, start_time: '10:00', duration_hours: 1, customer_name: 'Pedro Walkin', idempotency_key: key(), payments: [{ method: 'cash', amount: '300' }] });
    eq(r.status, 201, 'status');
    eq(r.data.reservation.status, 'confirmed', 'reservation');
    eq(r.data.transaction.status, 'completed', 'transaction');
  });

  console.log('\nMemberships & discounts');
  let membershipTrx: any;
  await test('sells a Premium monthly membership; expiry is computed', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), player_id: player.id, items: [{ item_type: 'membership', plan_id: premium.id, duration: 'monthly', action: 'new' }], payments: [{ method: 'cash', amount: '599' }] });
    eq(r.status, 201, 'status');
    eq(r.data.total, '599.00', 'price');
    eq(r.data.transaction_type, 'membership_registration', 'type');
    membershipTrx = r.data;
    const m = (await admin.get(`/memberships?player_id=${player.id}`)).data[0];
    eq(m.effective_status, 'active', 'status');
    const expected = (await pool.query(`select (manila_today() + interval '1 month' - interval '1 day')::date::text as d`)).rows[0].d;
    eq(m.end_date, expected, 'end date');
  });
  await test('a second "new" membership is refused', async () => {
    eq((await cashier.post('/transactions/checkout', { idempotency_key: key(), player_id: player.id, items: [{ item_type: 'membership', plan_id: premium.id, action: 'new' }], payments: [{ method: 'cash', amount: '599' }] })).status, 409, 'status');
  });
  await test('member gets 15% off court rental only (not products)', async () => {
    const p = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, player_id: player.id,
      items: [{ item_type: 'court', booking: { court_id: courts[1].id, date, start_time: '14:00', duration_hours: 2 } }, { item_type: 'product', ref_id: water.id }] });
    eq(p.status, 200, 'status');
    eq(p.data.lines[0].discount_amount, '82.50', 'court discount');
    eq(p.data.lines[1].discount_amount, '0.00', 'product discount');
    eq(p.data.total, '492.50', 'total');
    const still = await recep.get(`/reservations?from=${date}&to=${date}&court_id=${courts[1].id}`);
    ok(!still.data.some((r: any) => r.start_time === '14:00'), 'preview must not create a reservation');
  });
  await test('member free paddle rental: 1 per month, then refused', async () => {
    const body = () => ({ idempotency_key: key(), player_id: player.id, items: [{ item_type: 'equipment', ref_id: paddle.id, hours: 1, use_entitlement: true }], payments: [] });
    const first = await cashier.post('/transactions/checkout', body());
    eq(first.status, 201, 'first');
    eq(first.data.total, '0.00', 'free');
    const second = await cashier.post('/transactions/checkout', body());
    eq(second.status, 409, 'second');
    eq(second.data.code, 'ENTITLEMENT_USED', 'code');
  });
  await test('an expired membership earns no discount', async () => {
    const mem = (await admin.get(`/memberships?player_id=${player.id}`)).data[0];
    await pool.query(`update player_memberships set start_date = manila_today() - 40, end_date = manila_today() - 5 where id = $1`, [mem.id]);
    const q = await recep.post('/reservations/quote', { court_id: courts[1].id, date, start_time: '14:00', duration_hours: 2, player_id: player.id });
    eq(q.data.discount_amount, '0.00', 'discount');
    await pool.query(`update player_memberships set start_date = manila_today(), end_date = manila_today() + 29 where id = $1`, [mem.id]);
  });
  await test('upgrade to VIP replaces the current membership', async () => {
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), player_id: player.id, items: [{ item_type: 'membership', plan_id: vip.id, duration: 'quarterly', action: 'upgrade' }], payments: [{ method: 'credit_card', amount: '2997', reference_no: 'CC1' }] });
    eq(r.status, 201, 'status');
    eq(r.data.total, '2997.00', 'price');
    const list = (await admin.get(`/memberships?player_id=${player.id}`)).data;
    eq(list.filter((m: any) => m.status === 'active').length, 1, 'active memberships');
    eq(list.find((m: any) => m.status === 'active').plan_code, 'VIP', 'plan');
    eq(list.filter((m: any) => m.status === 'replaced').length, 1, 'replaced memberships');
  });
  await test('promo code applies only to eligible items; discounts do not stack with membership', async () => {
    const walkin = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, customer_name: 'Promo Guest', discount: { code: 'welcome10' },
      items: [{ item_type: 'court', booking: { court_id: courts[1].id, date, start_time: '16:00', duration_hours: 1 } }, { item_type: 'product', ref_id: water.id }] });
    eq(walkin.data.discount_total, '30.00', 'promo on court only');
    const member = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, player_id: player.id, discount: { code: 'WELCOME10' },
      items: [{ item_type: 'court', booking: { court_id: courts[1].id, date, start_time: '16:00', duration_hours: 1 } }] });
    eq(member.data.discount_total, '75.00', 'VIP 25% kept, promo 10% not added');
    eq(member.data.manual_discount, '0.00', 'promo dropped');
  });
  await test('Senior Citizen discount: ID required; 20% when non-VAT; VAT-exempt maths when VAT-registered', async () => {
    const senior = discounts.find((d: any) => d.discount_type === 'senior');
    const items = [{ item_type: 'court', booking: { court_id: courts[1].id, date, start_time: '17:00', duration_hours: 1 } }, { item_type: 'product', ref_id: water.id }];
    const noId = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, customer_name: 'Lola', discount: { discount_id: senior.id }, items });
    eq(noId.data.code, 'ID_REQUIRED', 'id required');
    const nonVat = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, customer_name: 'Lola', discount: { discount_id: senior.id, id_number: 'SC-123' }, items });
    eq(nonVat.data.discount_total, '60.00', 'non-VAT: 20% of 300, product excluded');
    await admin.put('/settings', { vat_registered: true });
    const vat = await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, customer_name: 'Lola', discount: { discount_id: senior.id, id_number: 'SC-123' }, items });
    await admin.put('/settings', { vat_registered: false });
    eq(vat.data.lines[0].line_total, '214.29', 'VAT: 300 / 1.12 x 0.80');
    eq(vat.data.vat_exempt_sales, '214.29', 'vat exempt sales');
    eq(vat.data.vat_amount, '2.68', 'VAT on the 25.00 product');
  });
  await test('a restricted discount needs manager credentials', async () => {
    const mgr = discounts.find((d: any) => d.code === 'MGR50');
    const body = (approver?: unknown) => ({ idempotency_key: key(), customer_name: 'Goodwill', discount: { discount_id: mgr.id }, approver, items: [{ item_type: 'service', ref_id: services.find((s: any) => s.code === 'SVC-COACH').id }], payments: [{ method: 'cash', amount: '450' }] });
    eq((await cashier.post('/transactions/checkout', body())).data.code, 'APPROVAL_REQUIRED', 'no approver');
    eq((await cashier.post('/transactions/checkout', body({ email: managerEmail, password: 'not-the-password' }))).data.code, 'APPROVAL_INVALID', 'bad approver');
    const okRes = await cashier.post('/transactions/checkout', body({ email: managerEmail, password: pw }));
    eq(okRes.status, 201, 'approved');
    eq(okRes.data.total, '450.00', 'total after ₱50 off');
    ok(okRes.data.approved_by_name?.includes('manager'), 'approver recorded');
  });

  console.log('\nEquipment rental');
  await test('paid rental reserves units; return restores them and records damage', async () => {
    const before = (await admin.get('/equipment')).data.find((e: any) => e.id === paddle.id);
    const r = await cashier.post('/transactions/checkout', { idempotency_key: key(), customer_name: 'Renter', items: [{ item_type: 'equipment', ref_id: paddle.id, quantity: 2, hours: 2 }], payments: [{ method: 'cash', amount: '200' }] });
    eq(r.data.total, '200.00', '2 paddles x 2h x 50');
    eq((await admin.get('/equipment')).data.find((e: any) => e.id === paddle.id).available_qty, before.available_qty - 2, 'available after issue');
    const rental = (await cashier.get('/rentals?status=rented')).data.find((x: any) => x.transaction_no === r.data.transaction_no);
    ok(rental.expected_return_at, 'expected return time recorded');
    const ret = await cashier.post(`/rentals/${rental.id}/return`, { qty_damaged: 1 });
    eq(ret.data.status, 'returned_with_issues', 'status');
    const after = (await admin.get('/equipment')).data.find((e: any) => e.id === paddle.id);
    eq(after.available_qty, before.available_qty - 1, 'available after return');
    eq(after.damaged_qty, before.damaged_qty + 1, 'damaged');
    eq((await cashier.post(`/rentals/${rental.id}/return`, {})).status, 409, 'double return');
  });
  await test('cannot rent more units than are available', async () => {
    eq((await cashier.post('/transactions/checkout', { idempotency_key: key(), items: [{ item_type: 'equipment', ref_id: paddle.id, quantity: 500 }], payments: [{ method: 'cash', amount: '25000' }] })).data.code, 'EQUIPMENT_UNAVAILABLE', 'code');
  });

  console.log('\nRefunds & immutability');
  await test('cashier cannot refund without manager approval', async () => {
    eq((await cashier.post(`/transactions/${sale.id}/refunds`, { amount: '95', method: 'cash', reason: 'Customer changed mind' })).data.code, 'APPROVAL_REQUIRED', 'code');
  });
  await test('authorised full refund: reversal record, status refunded, stock returned, sale untouched', async () => {
    const before = (await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty;
    const r = await cashier.post(`/transactions/${sale.id}/refunds`, { amount: '95', method: 'cash', reason: 'Customer changed mind', restock: true, approver: { email: managerEmail, password: pw } });
    eq(r.status, 201, 'status');
    eq(r.data.status, 'refunded', 'status');
    eq(r.data.total, '95.00', 'original total unchanged');
    ok(/^EKR-\d{4}-\d{6}$/.test(r.data.refunds[0].refund_no), 'refund number');
    eq((await admin.get('/products')).data.find((p: any) => p.id === water.id).stock_qty, before + 3, 'restocked');
    eq((await cashier.post(`/transactions/${sale.id}/refunds`, { amount: '1', method: 'cash', reason: 'again', approver: { email: managerEmail, password: pw } })).status, 400, 'over-refund');
  });
  await test('refunding a membership sale cancels that membership', async () => {
    const list = (await admin.get(`/memberships?player_id=${player.id}`)).data;
    const vipM = list.find((m: any) => m.status === 'active');
    const trx = (await admin.get(`/transactions?q=${vipM.transaction_no}`)).data.rows[0];
    eq((await admin.post(`/transactions/${trx.id}/refunds`, { amount: '2997', method: 'credit_card', reason: 'Bought by mistake' })).status, 201, 'refund');
    eq((await admin.get(`/memberships?player_id=${player.id}`)).data.find((m: any) => m.id === vipM.id).status, 'cancelled', 'membership');
    ok(membershipTrx.id, 'first membership transaction retained');
  });
  await test('the database refuses to edit or delete completed financial records', async () => {
    const attempt = (sql: string) => pool.query(sql, [sale.id]).then(() => 'allowed', (e) => e.code);
    eq(await attempt('update transactions set total = 1 where id = $1'), 'P0001', 'update total');
    eq(await attempt('delete from transactions where id = $1'), 'P0001', 'delete transaction');
    eq(await attempt('update transaction_items set unit_price = 1 where transaction_id = $1'), 'P0001', 'update items');
    eq(await attempt('delete from payments where transaction_id = $1'), 'P0001', 'delete payments');
    eq(await pool.query(`delete from audit_logs where action = 'auth.login'`).then(() => 'allowed', (e) => e.code), 'P0001', 'delete audit log');
  });
  await test('changing a price does not change past transactions', async () => {
    await admin.put(`/products/${water.id}`, { selling_price: '40.00' });
    eq((await admin.get(`/transactions/${sale.id}`)).data.items.find((i: any) => i.item_type === 'product').unit_price, '25.00', 'historical unit price');
    eq((await cashier.post('/transactions/checkout', { idempotency_key: 'preview-00000000', preview: true, items: [{ item_type: 'product', ref_id: water.id }] })).data.total, '40.00', 'new price');
    await admin.put(`/products/${water.id}`, { selling_price: '25.00' });
  });

  console.log('\nShift reconciliation, expenses, reports');
  await test('cash in / cash out / drawer expense are recorded', async () => {
    eq((await cashier.post('/shifts/movements', { movement_type: 'cash_in', amount: '500', reason: 'Extra change fund' })).status, 201, 'cash in');
    eq((await cashier.post('/shifts/movements', { movement_type: 'cash_out', amount: '200', reason: 'Bank deposit' })).status, 201, 'cash out');
    const cat = (await admin.get('/expense-categories')).data[0];
    eq((await cashier.post('/shifts/movements', { movement_type: 'expense', amount: '150', reason: 'Cleaning supplies', category_id: cat.id })).status, 201, 'expense');
  });
  await test('closing the shift reconciles expected cash against the payment records', async () => {
    const cur = (await cashier.get('/shifts/current')).data;
    const db = (await pool.query(
      `select (select opening_cash from cashier_shifts where id = $1)
            + coalesce((select sum(amount) from payments where shift_id = $1 and method = 'cash'), 0)
            - coalesce((select sum(amount) from refunds where shift_id = $1 and method = 'cash'), 0) + 500 - 200 - 150 as expected`, [shift.id])).rows[0].expected;
    eq(cur.summary.expected_cash, db, 'expected cash');
    const actual = (Number(db) - 20).toFixed(2);
    const closed = await cashier.post(`/shifts/${shift.id}/close`, { actual_cash: actual, notes: 'Test close' });
    eq(closed.data.status, 'closed', 'status');
    eq(closed.data.variance, '-20.00', 'shortage');
    eq(await pool.query(`update cashier_shifts set actual_cash = 0 where id = $1`, [shift.id]).then(() => 'allowed', (e) => e.code), 'P0001', 'closed shift is final');
  });
  await test('expense approval flow; only approved expenses count', async () => {
    const cat = (await admin.get('/expense-categories')).data[1];
    const x = await admin.post('/expenses', { expense_date: date, category_id: cat.id, description: 'Test water bill', amount: '1234.50', payment_method: 'bank_transfer' });
    eq(x.data.status, 'pending', 'pending');
    ok(/^EKX-\d{4}-\d{6}$/.test(x.data.expense_no), 'expense number');
    eq((await cashier.post(`/expenses/${x.data.id}/decision`, { status: 'approved' })).status, 403, 'cashier cannot approve');
    eq((await admin.post(`/expenses/${x.data.id}/decision`, { status: 'approved' })).data.status, 'approved', 'approved');
    eq((await admin.put(`/expenses/${x.data.id}`, { expense_date: date, category_id: cat.id, description: 'edit', amount: '1' })).status, 409, 'approved expense locked');
  });
  await test('dashboard figures equal the database totals', async () => {
    const d = (await admin.get('/dashboard')).data;
    const db = (await pool.query(`select
        (select coalesce(sum(amount), 0) from payments where manila_date(created_at) = manila_today())
      - (select coalesce(sum(amount), 0) from refunds where manila_date(created_at) = manila_today()) as revenue,
        (select count(*)::int from transactions where manila_date(created_at) = manila_today()) as txns,
        (select count(*)::int from players) as players`)).rows[0];
    eq(d.stats.today_revenue, db.revenue, 'today revenue');
    eq(d.stats.today_transactions, db.txns, 'today transactions');
    eq(d.stats.total_players, db.players, 'players');
    eq((await recep.get('/dashboard')).data.stats.today_revenue, undefined, 'receptionist sees no revenue');
  });
  await test('all 21 reports run against real data', async () => {
    const list = (await admin.get('/reports')).data;
    eq(list.length, 21, 'report count');
    const today = (await pool.query(`select manila_today()::text as d`)).rows[0].d;
    for (const r of list) {
      const res = await admin.get(`/reports/${r.id}?from=${today}&to=${date}`);
      eq(res.status, 200, r.id);
      ok(Array.isArray(res.data.rows), `${r.id} rows`);
    }
    const sales = (await admin.get(`/reports/daily_sales?from=${today}&to=${today}`)).data;
    const db = (await pool.query(`select coalesce(sum(amount), 0) as c from payments where manila_date(created_at) = manila_today()`)).rows[0].c;
    eq(sales.rows[0].collected, db, 'daily sales collected');
    eq((await cashier.get(`/reports/daily_sales?from=${today}&to=${today}`)).status, 403, 'cashier cannot view reports');
  });
  await test('important actions are in the audit log', async () => {
    const actions = new Set((await pool.query(`select distinct action from audit_logs where created_at > now() - interval '15 minutes'`)).rows.map((r) => r.action));
    for (const a of ['auth.login', 'auth.login_failed', 'player.register', 'reservation.create', 'reservation.reschedule', 'transaction.complete', 'refund.process',
      'membership.new', 'membership.upgrade', 'product.update', 'inventory.stock_in', 'shift.open', 'shift.close', 'settings.update', 'expense.approved']) ok(actions.has(a), `missing audit action ${a}`);
    eq((await cashier.get('/audit-logs')).status, 403, 'cashier cannot read audit log');
  });
  await test('cancelling a reservation frees the slot', async () => {
    const r = await recep.post('/reservations', { court_id: courts[3].id, date, start_time: '18:00', duration_hours: 1, customer_name: 'To cancel' });
    eq((await recep.post(`/reservations/${r.data.reservation.id}/cancel`, { reason: 'Customer request' })).data.status, 'cancelled', 'cancelled');
    eq((await recep.post('/reservations', { court_id: courts[3].id, date, start_time: '18:00', duration_hours: 1, customer_name: 'Rebook' })).status, 201, 'slot reusable');
  });
  await test('uploads are stored in the database and served only to signed-in users', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const send = async (blob: Blob, filename: string) => {
      const fd = new FormData();
      fd.append('file', blob, filename);
      const res = await fetch(base + '/uploads', { method: 'POST', headers: { 'X-Requested-With': 'ekourt', Cookie: admin.cookie }, body: fd });
      return { status: res.status, data: (await res.json().catch(() => null)) as any };
    };
    const up = await send(new Blob([png], { type: 'image/png' }), '../../evil name.png');
    eq(up.status, 201, 'upload');
    ok(/^\/uploads\/[a-f0-9]{32}\.png$/.test(up.data.url), `server-generated name, got ${up.data.url}`);
    const origin = base.replace(/\/api$/, '');
    const got = await fetch(origin + up.data.url, { headers: { Cookie: admin.cookie } });
    eq(got.status, 200, 'download');
    eq(got.headers.get('content-type'), 'image/png', 'content type');
    ok(Buffer.from(await got.arrayBuffer()).equals(png), 'bytes round-trip unchanged');
    eq((await fetch(origin + up.data.url)).status, 401, 'anonymous download');
    eq((await send(new Blob(['<script>'], { type: 'text/html' }), 'x.html')).status, 400, 'html rejected');
    eq((await pool.query('select count(*)::int n from uploaded_files where name = $1', [up.data.url.split('/').pop()])).rows[0].n, 1, 'row in database');
  });

  // Deactivate the test logins and restore settings touched above.
  await pool.query(`update employees set is_active = false where email like $1`, [`%.${run}@test.ekourt.local`]);
  await admin.put('/settings', { max_advance_booking_days: 30 }).catch(() => {});
  await pool.query(`update business_settings set value = '30' where key = 'max_advance_booking_days'`);

  server.close();
  await pool.end();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
