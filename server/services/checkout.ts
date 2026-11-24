// The financial core: POS checkout, balance payments and refunds.
// Every function here runs inside ONE database transaction supplied by the caller,
// prices everything from the database (never from the client), and writes an audit row.
import { z } from 'zod';
import { PAYMENT_METHODS } from '../../shared/permissions';
import { audit } from '../audit';
import { has, verifyApprover } from '../auth';
import { one, type Q } from '../db';
import { badRequest, conflict, forbidden, notFound, zId, zMoney, zOptId, zOptText, type AuthUser } from '../http';
import { D, m, minD, r2, sum, ZERO, type Dec } from '../money';
import { activeMembership, getSettings, numbers, openShift, type Settings } from './common';
import { bookingSchema, createReservation, LIVE_STATUSES } from './reservations';

const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: zMoney,
  reference_no: zOptText.optional(),
});
const approverSchema = z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional();

const itemSchema = z.object({
  item_type: z.enum(['court', 'product', 'service', 'equipment', 'membership', 'charge']),
  ref_id: zOptId.optional(),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  // equipment
  hours: z.coerce.number().positive().max(24).optional(),
  use_entitlement: z.boolean().optional(),
  // membership
  plan_id: zOptId.optional(),
  duration: z.enum(['monthly', 'quarterly', 'semi_annual', 'annual']).optional(),
  action: z.enum(['new', 'renewal', 'upgrade', 'downgrade']).optional(),
  // court: either ref_id = an existing unbilled reservation, or a new booking
  booking: bookingSchema.omit({ player_id: true, customer_name: true }).optional(),
  // ad-hoc charge
  description: zOptText.optional(),
  amount: zMoney.optional(),
});

export const checkoutSchema = z.object({
  idempotency_key: z.string().min(8).max(80),
  player_id: zOptId.optional(),
  customer_name: zOptText.optional(),
  items: z.array(itemSchema).min(1).max(100),
  discount: z.object({ discount_id: zOptId.optional(), code: zOptText.optional(), id_number: zOptText.optional() }).nullable().optional(),
  payments: z.array(paymentSchema).max(8).default([]),
  allow_partial: z.boolean().optional(),
  approver: approverSchema,
  notes: zOptText.optional(),
  /** When true nothing is saved: returns the computed totals only (used for the live POS preview). */
  preview: z.boolean().optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const addPaymentSchema = z.object({
  idempotency_key: z.string().min(8).max(80),
  payments: z.array(paymentSchema).min(1).max(8),
});

export const refundSchema = z.object({
  amount: zMoney,
  method: z.enum(PAYMENT_METHODS),
  reason: z.string().trim().min(3).max(500),
  restock: z.boolean().optional(),
  approver: approverSchema,
});

interface Line {
  item_type: string;
  ref_id: string | null;
  description: string;
  quantity: number;
  unit_price: Dec;
  gross: Dec;
  memberDisc: Dec;
  manualDisc: Dec;
  vatExempt: boolean;
  meta: Record<string, unknown>;
  apply?: (txId: string) => Promise<void>;
}

const SERVICE_TYPE: Record<string, string> = { coaching: 'coaching', tournament: 'tournament_registration' };

class PreviewRollback extends Error {
  constructor(public payload: unknown) {
    super('preview');
  }
}
export { PreviewRollback };

// ---------------------------------------------------------------------------
// Tender handling: non-cash is applied exactly, cash may exceed and yields change.
// ---------------------------------------------------------------------------
function settle(payments: { method: string; amount: string; reference_no?: string | null }[], due: Dec) {
  for (const p of payments) if (!D(p.amount).gt(0)) throw badRequest('Each payment amount must be greater than zero');
  const nonCash = payments.filter((p) => p.method !== 'cash');
  const cashTendered = sum(payments.filter((p) => p.method === 'cash').map((p) => p.amount));
  const nonCashTotal = sum(nonCash.map((p) => p.amount));
  if (nonCashTotal.gt(due)) throw badRequest('Non-cash payments exceed the amount due');
  const cashApplied = minD(cashTendered, due.minus(nonCashTotal));
  const rows = nonCash.map((p) => ({ method: p.method, amount: D(p.amount), tendered: D(p.amount), reference_no: p.reference_no ?? null }));
  if (cashApplied.gt(0)) rows.push({ method: 'cash', amount: cashApplied, tendered: cashTendered, reference_no: null });
  const paid = nonCashTotal.plus(cashApplied);
  return { rows, paid, change: cashTendered.minus(cashApplied), balance: due.minus(paid) };
}

// ---------------------------------------------------------------------------
// Line builders
// ---------------------------------------------------------------------------
async function buildLines(q: Q, user: AuthUser, input: CheckoutInput, settings: Settings, membership: any, ip?: string) {
  const lines: Line[] = [];
  let reservationId: string | null = null;
  let walkIn = false;
  const memberPct = membership ? D(membership.court_discount_percent) : ZERO;
  const memberDiscFor = (type: string, gross: Dec) =>
    membership && settings.member_discount_types.includes(type) ? r2(gross.times(memberPct).div(100)) : ZERO;
  const base = (l: Partial<Line> & Pick<Line, 'item_type' | 'description' | 'quantity' | 'unit_price' | 'gross'>): Line => ({
    ref_id: null, memberDisc: memberDiscFor(l.item_type, l.gross), manualDisc: ZERO, vatExempt: false, meta: {}, ...l,
  });

  for (const it of input.items) {
    const qty = it.quantity;

    if (it.item_type === 'product') {
      const p = await one(q, 'select * from products where id = $1', [it.ref_id]);
      if (!p || p.status !== 'active') throw notFound('Product');
      const price = D(p.selling_price);
      lines.push(base({
        item_type: 'product', ref_id: p.id, description: p.name, quantity: qty, unit_price: price, gross: r2(price.times(qty)),
        meta: { code: p.code },
        apply: async (txId) => {
          // Atomic conditional decrement: two tills can never oversell the last unit.
          const upd = await one(q, 'update products set stock_qty = stock_qty - $2 where id = $1 and stock_qty >= $2 returning stock_qty', [p.id, qty]);
          if (!upd) throw conflict(`Not enough stock for ${p.name}`, 'OUT_OF_STOCK');
          await q.query(
            `insert into inventory_movements (product_id, movement_type, quantity, balance_after, unit_cost, transaction_id, notes, created_by)
             values ($1, 'sale', $2, $3, $4, $5, 'POS sale', $6)`,
            [p.id, -qty, upd.stock_qty, p.cost_price, txId, user.id],
          );
        },
      }));
    } else if (it.item_type === 'service') {
      const s = await one(q, 'select * from services where id = $1', [it.ref_id]);
      if (!s || !s.is_active) throw notFound('Service');
      const price = D(s.price);
      lines.push(base({
        item_type: 'service', ref_id: s.id, description: s.name, quantity: qty, unit_price: price, gross: r2(price.times(qty)),
        meta: { code: s.code, category: s.category, charge_method: s.charge_method },
      }));
    } else if (it.item_type === 'equipment') {
      const e = await one(q, 'select * from equipment where id = $1', [it.ref_id]);
      if (!e || !e.is_active) throw notFound('Equipment');
      const hours = e.charge_method === 'per_hour' ? (it.hours ?? 1) : null;
      let unit = e.charge_method === 'per_hour' ? r2(D(e.rental_rate).times(hours!)) : D(e.rental_rate);
      const free = !!it.use_entitlement;
      if (free) {
        if (!membership) throw badRequest('Free rentals are only available to players with a valid membership');
        if (!e.entitlement_type || !(membership.free_paddle_rentals_per_month > 0)) throw badRequest(`${e.name} is not covered by this membership`);
        unit = ZERO;
      }
      const customer = input.customer_name ?? 'Walk-in Customer';
      lines.push(base({
        item_type: 'equipment', ref_id: e.id, quantity: qty, unit_price: unit, gross: r2(unit.times(qty)),
        description: `${e.name} rental${hours ? ` (${hours} hr)` : ''}${free ? ' — member free rental' : ''}`,
        meta: { code: e.code, hours, free_entitlement: free },
        apply: async (txId) => {
          if (free) {
            await q.query(
              `insert into membership_entitlements (membership_id, entitlement_type, period_start, quantity_total)
               values ($1, $2, date_trunc('month', manila_today())::date, $3)
               on conflict (membership_id, entitlement_type, period_start) do nothing`,
              [membership.id, e.entitlement_type, membership.free_paddle_rentals_per_month],
            );
            const used = await one(
              q,
              `update membership_entitlements set quantity_used = quantity_used + $3
               where membership_id = $1 and entitlement_type = $2 and period_start = date_trunc('month', manila_today())::date
                 and quantity_used + $3 <= quantity_total returning id`,
              [membership.id, e.entitlement_type, qty],
            );
            if (!used) throw conflict('No free rentals left for this month', 'ENTITLEMENT_USED');
          }
          // Atomic conditional decrement: the same unit can never be issued twice.
          const upd = await one(q, 'update equipment set available_qty = available_qty - $2 where id = $1 and available_qty >= $2 returning id', [e.id, qty]);
          if (!upd) throw conflict(`Not enough ${e.name} available to rent`, 'EQUIPMENT_UNAVAILABLE');
          await q.query(
            `insert into equipment_rentals (rental_no, equipment_id, player_id, customer_name, quantity, expected_return_at, charge,
                is_free_entitlement, transaction_id, issued_by)
             values ($1,$2,$3,$4,$5, case when $6::numeric is null then null else now() + ($6::numeric * interval '1 hour') end, $7,$8,$9,$10)`,
            [await numbers.rental(q), e.id, input.player_id ?? null, customer, qty, hours, m(unit.times(qty)), free, txId, user.id],
          );
        },
      }));
    } else if (it.item_type === 'membership') {
      if (!input.player_id) throw badRequest('Select a registered player before selling a membership');
      if (lines.some((l) => l.item_type === 'membership')) throw badRequest('Only one membership can be sold per transaction');
      const plan = await one(q, 'select * from membership_plans where id = $1 and is_active', [it.plan_id ?? it.ref_id]);
      if (!plan) throw notFound('Membership plan');
      const duration = it.duration ?? 'monthly';
      const months = settings.duration_months[duration];
      if (!months) throw badRequest('Unknown membership duration');
      await q.query(`update player_memberships set status = 'expired' where player_id = $1 and status = 'active' and end_date < manila_today()`, [input.player_id]);
      const current = await one(q, `select pm.*, mp.monthly_price as current_price from player_memberships pm join membership_plans mp on mp.id = pm.plan_id
                                    where pm.player_id = $1 and pm.status in ('active','suspended') for update of pm`, [input.player_id]);
      const last = current ?? (await one(q, 'select * from player_memberships where player_id = $1 order by created_at desc limit 1', [input.player_id]));
      let action = it.action ?? (current ? 'renewal' : 'new');
      if (action === 'new' && current) throw conflict('This player already has a membership. Use Renew, Upgrade or Downgrade instead', 'HAS_MEMBERSHIP');
      if ((action === 'upgrade' || action === 'downgrade') && !current) throw badRequest('There is no current membership to change');
      if ((action === 'upgrade' || action === 'downgrade') && current.plan_id === plan.id) throw badRequest('Choose a different plan to upgrade or downgrade');
      if (action === 'renewal' && current && current.plan_id !== plan.id) {
        action = D(plan.monthly_price).gt(current.current_price) ? 'upgrade' : 'downgrade';
      }
      if (current?.status === 'suspended') throw conflict('This membership is suspended. Resume or cancel it first');
      const price = r2(D(plan.monthly_price).times(months));
      // A renewal continues from the day after the current term ends; plan changes start today.
      const carryOn = action === 'renewal' && current;
      lines.push(base({
        item_type: 'membership', ref_id: plan.id, quantity: 1, unit_price: price, gross: price,
        description: `${plan.name} — ${duration.replace('_', '-')} (${action})`,
        meta: { plan_code: plan.code, duration, action, months },
        apply: async (txId) => {
          if (current) await q.query(`update player_memberships set status = 'replaced', status_reason = $2, status_changed_at = now(), status_changed_by = $3 where id = $1`, [current.id, action, user.id]);
          const mem = await one(
            q,
            `insert into player_memberships (membership_no, player_id, plan_id, duration, action, start_date, end_date, price_paid, transaction_id, previous_membership_id, created_by)
             select $1, $2::uuid, $3::uuid, $4, $5, s.start_date, (s.term_start + make_interval(months => $6::int) - interval '1 day')::date, $7::numeric, $8::uuid, $9::uuid, $10::uuid
             from (select case when $11::boolean then $12::date else manila_today() end as start_date,
                          case when $11::boolean then greatest($13::date + 1, manila_today()) else manila_today() end as term_start) s
             returning *`,
            [await numbers.membership(q), input.player_id, plan.id, duration, action, months, m(price), txId, last?.id ?? null, user.id,
              !!carryOn, current?.start_date ?? null, current?.end_date ?? null],
          );
          await audit(q, { user, ip }, `membership.${action}`, 'membership', mem.id, {
            membership_no: mem.membership_no, plan: plan.name, duration, start_date: mem.start_date, end_date: mem.end_date,
          });
        },
      }));
    } else if (it.item_type === 'court') {
      if (reservationId) throw badRequest('Only one court booking can be paid per transaction');
      let res: any;
      if (it.booking) {
        const created = await createReservation(q, user, { ...it.booking, player_id: input.player_id ?? null, customer_name: input.customer_name ?? null, is_walk_in: it.booking.is_walk_in ?? true }, ip);
        res = created.reservation;
        walkIn = !input.player_id;
      } else {
        res = await one(q, 'select * from reservations where id = $1 for update', [it.ref_id]);
        if (!res) throw notFound('Reservation');
        if (!LIVE_STATUSES.includes(res.status) && res.status !== 'completed') throw conflict(`Reservation ${res.reference_no} is ${res.status.replace('_', ' ')}`);
        const billed = await one(q, 'select transaction_no from transactions where reservation_id = $1 limit 1', [res.id]);
        if (billed) throw conflict(`Reservation ${res.reference_no} is already billed on ${billed.transaction_no}. Add a balance payment to that transaction instead`, 'ALREADY_BILLED');
      }
      reservationId = res.id;
      const court = await one(q, 'select name from courts where id = $1', [res.court_id]);
      const when = await one(q, `select to_char($1::timestamptz at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM') as s`, [res.start_at]);
      const gross = D(res.rate_amount);
      lines.push(base({
        item_type: 'court', ref_id: res.id, quantity: 1, unit_price: gross, gross,
        description: `${court.name} — ${when.s} (${Number(res.duration_hours)} hr)`,
        meta: { reference_no: res.reference_no, rate_type: res.rate_type, duration_hours: Number(res.duration_hours) },
      }));
    } else {
      if (!it.description || !it.amount) throw badRequest('An additional charge needs a description and an amount');
      const price = D(it.amount);
      lines.push(base({ item_type: 'charge', description: it.description, quantity: qty, unit_price: price, gross: r2(price.times(qty)), memberDisc: ZERO }));
    }
  }
  return { lines, reservationId, walkIn };
}

// ---------------------------------------------------------------------------
// Discounts: one manual discount per sale, never silently stacked on the member discount.
// ---------------------------------------------------------------------------
async function applyManualDiscount(q: Q, user: AuthUser, input: CheckoutInput, settings: Settings, lines: Line[]) {
  const req = input.discount;
  if (!req || (!req.discount_id && !req.code)) return null;
  const d = req.discount_id
    ? await one(q, 'select * from discounts where id = $1', [req.discount_id])
    : await one(q, 'select * from discounts where upper(code) = upper($1)', [req.code]);
  if (!d || !d.is_active) throw badRequest('That discount or promo code is not valid', 'DISCOUNT_INVALID');
  const today = (await one(q, 'select manila_today()::text as d')).d as string;
  if ((d.valid_from && today < d.valid_from) || (d.valid_to && today > d.valid_to)) throw badRequest(`${d.name} is not valid today`, 'DISCOUNT_INVALID');
  if (d.usage_limit !== null && d.usage_count >= d.usage_limit) throw badRequest(`${d.name} has reached its usage limit`, 'DISCOUNT_INVALID');

  const statutory = d.discount_type === 'senior' || d.discount_type === 'pwd';
  if (statutory && !req.id_number) throw badRequest('Enter the Senior Citizen / PWD ID number to apply this discount', 'ID_REQUIRED');
  const types: string[] = statutory ? settings.sc_pwd_eligible_types : d.applies_to ?? [];
  const eligible = lines.filter((l) => (types.length === 0 || types.includes(l.item_type)) && l.gross.gt(0));
  if (!eligible.length) throw badRequest(`${d.name} does not apply to any item in this order`, 'DISCOUNT_INVALID');
  const stack = !!d.stackable_with_membership;
  const baseOf = (l: Line) => (stack ? l.gross.minus(l.memberDisc) : l.gross);
  const eligibleTotal = sum(eligible.map(baseOf));
  if (eligibleTotal.lt(d.min_amount)) throw badRequest(`${d.name} requires a minimum of ₱${m(d.min_amount)} on eligible items`, 'DISCOUNT_INVALID');

  let approvedBy: string | null = null;
  if (d.requires_approval) {
    approvedBy = has(user, 'discounts.approve') ? user.id : (await verifyApprover(q, input.approver, 'discounts.approve')).id;
  }

  if (statutory) {
    const rate = D(settings.sc_pwd_discount_rate).div(100);
    const vat = D(settings.vat_rate).div(100);
    for (const l of eligible) {
      const b = baseOf(l);
      if (settings.vat_registered) {
        // RA 9994 / RA 10754: remove VAT first, then take the discount off the VAT-exclusive price.
        const net = r2(b.div(vat.plus(1)).times(D(1).minus(rate)));
        l.manualDisc = b.minus(net);
        l.vatExempt = true;
      } else {
        l.manualDisc = r2(b.times(rate));
      }
    }
  } else if (d.value_type === 'percent') {
    for (const l of eligible) l.manualDisc = r2(baseOf(l).times(d.value).div(100));
  } else {
    // Fixed amount: spread across eligible lines pro rata; the last line absorbs rounding.
    const amount = minD(D(d.value), eligibleTotal);
    let left = amount;
    eligible.forEach((l, i) => {
      const share = i === eligible.length - 1 ? left : minD(left, r2(amount.times(baseOf(l)).div(eligibleTotal)));
      l.manualDisc = share;
      left = left.minus(share);
    });
  }

  const manualTotal = sum(lines.map((l) => l.manualDisc));
  const memberTotal = sum(lines.map((l) => l.memberDisc));
  if (!stack) {
    if (manualTotal.gte(memberTotal)) {
      for (const l of lines) l.memberDisc = ZERO; // the better single discount wins
    } else {
      for (const l of lines) { l.manualDisc = ZERO; l.vatExempt = false; }
      return { discount: d, applied: false as const, approvedBy: null, note: `Membership discount is larger than ${d.name}, so the membership discount was kept` };
    }
  }
  return { discount: d, applied: true as const, approvedBy, note: null as string | null };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
export async function checkout(q: Q, user: AuthUser, input: CheckoutInput, ip?: string) {
  if (!input.preview) {
    const replay = await one(q, 'select id from transactions where idempotency_key = $1', [input.idempotency_key]);
    if (replay) return { ...(await getTransaction(q, replay.id)), replayed: true };
  }

  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (!input.preview && settings.require_open_shift && !shift) throw conflict('Open a cashier shift before accepting payments', 'NO_SHIFT');

  let customerName = input.customer_name ?? null;
  if (input.player_id) {
    const player = await one(q, 'select * from players where id = $1', [input.player_id]);
    if (!player) throw notFound('Player');
    customerName = player.full_name;
  }
  input = { ...input, customer_name: customerName };
  // Only a membership that is valid today earns the member discount.
  const membership = (await activeMembership(q, input.player_id)) ?? null;

  const { lines, reservationId, walkIn } = await buildLines(q, user, input, settings, membership, ip);
  const manual = await applyManualDiscount(q, user, input, settings, lines);

  const lineDisc = (l: Line) => l.memberDisc.plus(l.manualDisc);
  const lineTotal = (l: Line) => l.gross.minus(lineDisc(l));
  const subtotal = sum(lines.map((l) => l.gross));
  const discountTotal = sum(lines.map(lineDisc));
  const total = subtotal.minus(discountTotal);
  if (total.lt(0)) throw badRequest('Discounts exceed the order total');

  let vatExempt = ZERO, vatAmount = ZERO, vatable = ZERO;
  if (settings.vat_registered) {
    vatExempt = sum(lines.filter((l) => l.vatExempt).map(lineTotal));
    const vatableGross = total.minus(vatExempt);
    vatAmount = r2(vatableGross.times(settings.vat_rate).div(D(100).plus(settings.vat_rate)));
    vatable = vatableGross.minus(vatAmount);
  }

  const memberTotal = sum(lines.map((l) => l.memberDisc));
  const manualTotal = sum(lines.map((l) => l.manualDisc));
  const labels = [
    memberTotal.gt(0) ? `${membership.plan_name} ${Number(membership.court_discount_percent)}%` : null,
    manual?.applied ? manual.discount.name : null,
  ].filter(Boolean);

  const summary = {
    customer_name: customerName ?? 'Walk-in Customer',
    membership: membership ? { plan_name: membership.plan_name, end_date: membership.end_date, discount_percent: membership.court_discount_percent } : null,
    lines: lines.map((l) => ({
      item_type: l.item_type, ref_id: l.ref_id, description: l.description, quantity: l.quantity,
      unit_price: m(l.unit_price), discount_amount: m(lineDisc(l)), line_total: m(lineTotal(l)),
    })),
    subtotal: m(subtotal), discount_total: m(discountTotal), member_discount: m(memberTotal), manual_discount: m(manualTotal),
    discount_label: labels.join(' + ') || null, discount_note: manual?.note ?? null,
    total: m(total), vatable_sales: m(vatable), vat_amount: m(vatAmount), vat_exempt_sales: m(vatExempt),
  };
  if (input.preview) throw new PreviewRollback(summary);

  const pay = settle(input.payments, total);
  if (pay.balance.gt(0)) {
    if (!input.allow_partial) throw badRequest(`Payment is short by ₱${m(pay.balance)}`, 'UNDERPAID');
    if (!input.player_id && !input.customer_name) throw badRequest('A customer name is required to leave a balance', 'UNDERPAID');
  }

  const types = [...new Set(lines.map((l) => {
    if (l.item_type === 'court') return walkIn ? 'walk_in' : 'court_rental';
    if (l.item_type === 'product') return 'product_purchase';
    if (l.item_type === 'equipment') return 'equipment_rental';
    if (l.item_type === 'membership') return l.meta.action === 'new' ? 'membership_registration' : 'membership_renewal';
    if (l.item_type === 'service') return SERVICE_TYPE[String(l.meta.category)] ?? 'service';
    return 'other_charges';
  }))];

  const trx = await one(
    q,
    `insert into transactions (transaction_no, transaction_type, player_id, customer_name, reservation_id, shift_id, cashier_id,
        subtotal, discount_total, total, vatable_sales, vat_amount, vat_exempt_sales, amount_paid, balance, change_due, status,
        discount_id, discount_label, discount_id_number, approved_by, idempotency_key, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning *`,
    [await numbers.transaction(q), types.length === 1 ? types[0] : 'mixed', input.player_id ?? null, summary.customer_name, reservationId,
      shift?.id ?? null, user.id, m(subtotal), m(discountTotal), m(total), m(vatable), m(vatAmount), m(vatExempt), m(pay.paid),
      m(pay.balance), m(pay.change), pay.balance.gt(0) ? 'partial' : 'completed', manual?.applied ? manual.discount.id : null,
      summary.discount_label, manual?.applied ? input.discount?.id_number ?? null : null, manual?.approvedBy ?? null,
      input.idempotency_key, input.notes ?? null],
  );

  for (const l of lines) {
    await q.query(
      `insert into transaction_items (transaction_id, item_type, ref_id, description, quantity, unit_price, discount_amount, line_total, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trx.id, l.item_type, l.ref_id, l.description, l.quantity, m(l.unit_price), m(lineDisc(l)), m(lineTotal(l)), JSON.stringify({ ...l.meta, vat_exempt: l.vatExempt })],
    );
    if (l.apply) await l.apply(trx.id);
  }

  for (const p of pay.rows) {
    await q.query(
      `insert into payments (transaction_id, reservation_id, shift_id, kind, method, amount, tendered, reference_no, received_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trx.id, reservationId, shift?.id ?? null, reservationId && pay.balance.gt(0) ? 'deposit' : 'payment', p.method, m(p.amount), m(p.tendered), p.reference_no, user.id],
    );
  }

  if (manual?.applied) {
    const used = await one(q, 'update discounts set usage_count = usage_count + 1 where id = $1 and (usage_limit is null or usage_count < usage_limit) returning id', [manual.discount.id]);
    if (!used) throw conflict(`${manual.discount.name} has reached its usage limit`, 'DISCOUNT_INVALID');
    await q.query(`insert into discount_usage (kind, discount_id, transaction_id, player_id, amount, approved_by) values ('discount',$1,$2,$3,$4,$5)`,
      [manual.discount.id, trx.id, input.player_id ?? null, m(manualTotal), manual.approvedBy]);
  }
  if (memberTotal.gt(0)) {
    await q.query(`insert into discount_usage (kind, membership_id, transaction_id, player_id, amount) values ('membership',$1,$2,$3,$4)`,
      [membership.id, trx.id, input.player_id, m(memberTotal)]);
  }

  if (reservationId) {
    const courtLine = lines.find((l) => l.item_type === 'court')!;
    await q.query(
      `update reservations set discount_amount = $2, total_amount = $3, amount_paid = amount_paid + $4, updated_by = $5,
              status = case when status = 'pending' and ($4::numeric > 0 or $3::numeric = 0) then 'confirmed' else status end
       where id = $1`,
      [reservationId, m(lineDisc(courtLine)), m(lineTotal(courtLine)), m(minD(pay.paid, lineTotal(courtLine))), user.id],
    );
  }

  await audit(q, { user, ip }, 'transaction.complete', 'transaction', trx.id, {
    transaction_no: trx.transaction_no, total: m(total), paid: m(pay.paid), balance: m(pay.balance),
    methods: pay.rows.map((p) => p.method), discount: summary.discount_label, approved_by: manual?.approvedBy ?? undefined,
  });
  return { ...(await getTransaction(q, trx.id)), discount_note: summary.discount_note };
}

// ---------------------------------------------------------------------------
// Balance payment on a partially paid transaction
// ---------------------------------------------------------------------------
export async function addPayment(q: Q, user: AuthUser, txId: string, input: z.infer<typeof addPaymentSchema>, ip?: string) {
  const dup = await one(q, 'select transaction_id from payments where idempotency_key = $1', [input.idempotency_key]);
  if (dup) return getTransaction(q, dup.transaction_id);
  const trx = await one(q, 'select * from transactions where id = $1 for update', [txId]);
  if (!trx) throw notFound('Transaction');
  if (trx.status !== 'partial' || !D(trx.balance).gt(0)) throw conflict('This transaction has no outstanding balance');
  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (settings.require_open_shift && !shift) throw conflict('Open a cashier shift before accepting payments', 'NO_SHIFT');

  const pay = settle(input.payments, D(trx.balance));
  if (!pay.paid.gt(0)) throw badRequest('Enter a payment amount');
  let first = true;
  for (const p of pay.rows) {
    await q.query(
      `insert into payments (transaction_id, reservation_id, shift_id, kind, method, amount, tendered, reference_no, received_by, idempotency_key)
       values ($1,$2,$3,'balance',$4,$5,$6,$7,$8,$9)`,
      [trx.id, trx.reservation_id, shift?.id ?? null, p.method, m(p.amount), m(p.tendered), p.reference_no, user.id, first ? input.idempotency_key : null],
    );
    first = false;
  }
  await q.query(`update transactions set amount_paid = amount_paid + $2, balance = $3, change_due = $4, status = $5 where id = $1`,
    [trx.id, m(pay.paid), m(pay.balance), m(pay.change), pay.balance.gt(0) ? 'partial' : 'completed']);
  if (trx.reservation_id) {
    await q.query(`update reservations set amount_paid = least(total_amount, amount_paid + $2), updated_by = $3 where id = $1`, [trx.reservation_id, m(pay.paid), user.id]);
  }
  await audit(q, { user, ip }, 'payment.balance', 'transaction', trx.id, { transaction_no: trx.transaction_no, paid: m(pay.paid), balance: m(pay.balance) });
  return getTransaction(q, trx.id);
}

// ---------------------------------------------------------------------------
// Refunds: always a new reversal record, never an edit or delete of the sale.
// ---------------------------------------------------------------------------
export async function refund(q: Q, user: AuthUser, txId: string, input: z.infer<typeof refundSchema>, ip?: string) {
  const trx = await one(q, 'select * from transactions where id = $1 for update', [txId]);
  if (!trx) throw notFound('Transaction');
  const amount = D(input.amount);
  const refundable = D(trx.amount_paid).minus(trx.refunded_total);
  if (!amount.gt(0)) throw badRequest('Refund amount must be greater than zero');
  if (amount.gt(refundable)) throw badRequest(`At most ₱${m(refundable)} can be refunded on this transaction`);

  // Authorisation: the requester must hold refunds.approve, or a manager must sign off with their credentials.
  const approver = has(user, 'refunds.approve') ? user : await verifyApprover(q, input.approver, 'refunds.approve');
  if (!has(user, 'refunds.request') && !has(user, 'refunds.approve')) throw forbidden();

  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (input.method === 'cash' && settings.require_open_shift && !shift) throw conflict('Open a cashier shift before refunding cash', 'NO_SHIFT');

  const full = amount.eq(refundable) && D(trx.refunded_total).plus(amount).eq(trx.amount_paid);
  const restock = !!input.restock && full;
  const row = await one(
    q,
    `insert into refunds (refund_no, transaction_id, shift_id, amount, method, reason, restocked, requested_by, approved_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [await numbers.refund(q), trx.id, shift?.id ?? null, m(amount), input.method, input.reason, restock, user.id, approver.id],
  );
  await q.query(`update transactions set refunded_total = refunded_total + $2, status = $3 where id = $1`, [trx.id, m(amount), full ? 'refunded' : 'partially_refunded']);

  if (full) {
    const { rows: items } = await q.query('select * from transaction_items where transaction_id = $1', [trx.id]);
    for (const it of items) {
      if (it.item_type === 'product' && restock) {
        const upd = await one(q, 'update products set stock_qty = stock_qty + $2 where id = $1 returning stock_qty', [it.ref_id, Number(it.quantity)]);
        if (upd) {
          await q.query(
            `insert into inventory_movements (product_id, movement_type, quantity, balance_after, transaction_id, notes, created_by)
             values ($1, 'refund', $2, $3, $4, $5, $6)`,
            [it.ref_id, Number(it.quantity), upd.stock_qty, trx.id, `Refund ${row.refund_no}`, user.id],
          );
        }
      }
      if (it.item_type === 'membership') {
        await q.query(
          `update player_memberships set status = 'cancelled', status_reason = $2, status_changed_at = now(), status_changed_by = $3
           where transaction_id = $1 and status in ('active','suspended')`,
          [trx.id, `Refunded (${row.refund_no})`, user.id],
        );
      }
    }
  }
  if (trx.reservation_id) {
    await q.query('update reservations set amount_paid = greatest(0, amount_paid - $2), updated_by = $3 where id = $1', [trx.reservation_id, m(amount), user.id]);
  }
  await audit(q, { user, ip }, 'refund.process', 'transaction', trx.id, {
    transaction_no: trx.transaction_no, refund_no: row.refund_no, amount: m(amount), method: input.method, reason: input.reason,
    approved_by: approver.full_name, restocked: restock,
  });
  return getTransaction(q, trx.id);
}

export async function getTransaction(q: Q, id: string) {
  const trx = await one(
    q,
    `select t.*, e.full_name as cashier_name, p.player_no, a.full_name as approved_by_name, r.reference_no as reservation_no,
            s.shift_no, (t.amount_paid - t.refunded_total) as net_paid
     from transactions t
     join employees e on e.id = t.cashier_id
     left join players p on p.id = t.player_id
     left join employees a on a.id = t.approved_by
     left join reservations r on r.id = t.reservation_id
     left join cashier_shifts s on s.id = t.shift_id
     where t.id = $1`,
    [id],
  );
  if (!trx) throw notFound('Transaction');
  // Sequential on purpose: q may be a single transaction connection.
  const items = await q.query('select * from transaction_items where transaction_id = $1 order by created_at, id', [id]);
  const payments = await q.query(`select p.*, e.full_name as received_by_name from payments p join employees e on e.id = p.received_by where p.transaction_id = $1 order by p.created_at`, [id]);
  const refunds = await q.query(`select r.*, rq.full_name as requested_by_name, ap.full_name as approved_by_name from refunds r
             join employees rq on rq.id = r.requested_by join employees ap on ap.id = r.approved_by where r.transaction_id = $1 order by r.created_at`, [id]);
  return { ...trx, items: items.rows, payments: payments.rows, refunds: refunds.rows };
}
