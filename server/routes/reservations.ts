import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit';
import { can, has } from '../auth';
import { crud } from '../crud';
import { db, one, tx } from '../db';
import { badRequest, conflict, forbidden, notFound, parse, str, zBool, zDate, zId, zMoney, zOptText, zText, zTime } from '../http';
import { checkout, checkoutSchema } from '../services/checkout';
import { getSettings } from '../services/common';
import { quoteCourt } from '../services/pricing';
import { bookingSchema, createReservation, getReservation, LIVE_STATUSES, RESERVATION_SELECT, validateSlot } from '../services/reservations';

// ---------------------------------------------------------------------------
// Courts
// ---------------------------------------------------------------------------
export const courtsRouter = Router();

courtsRouter.get('/board', can('courts.view'), async (_req, res) => {
  const { rows } = await db.query(`
    select c.*,
      cur.id as current_id, cur.reference_no as current_ref, cur.customer_name as current_customer, cur.status as current_status,
      to_char(cur.end_at at time zone 'Asia/Manila', 'HH24:MI') as current_until,
      nxt.reference_no as next_ref, nxt.customer_name as next_customer, to_char(nxt.start_at at time zone 'Asia/Manila', 'HH24:MI') as next_at,
      case when not c.is_active or c.status = 'closed' then 'closed'
           when c.status = 'maintenance' then 'maintenance'
           when cur.status in ('checked_in','in_progress') then 'occupied'
           when cur.id is not null then 'reserved'
           else 'available' end as live_status
    from courts c
    left join lateral (
      select * from reservations r where r.court_id = c.id and r.status = any($1::text[]) and r.start_at <= now() and r.end_at > now()
      order by r.start_at limit 1) cur on true
    left join lateral (
      select * from reservations r where r.court_id = c.id and r.status = any($1::text[]) and r.start_at > now()
        and manila_date(r.start_at) = manila_today()
      order by r.start_at limit 1) nxt on true
    order by c.sort_order, c.name`, [LIVE_STATUSES]);
  res.json(rows);
});

courtsRouter.get('/:id/hours', can('courts.view'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { rows } = await db.query('select day_of_week, open_time, close_time, is_closed from court_operating_hours where court_id = $1 order by day_of_week', [id]);
  res.json(Array.from({ length: 7 }, (_, d) => rows.find((r) => r.day_of_week === d) ?? { day_of_week: d, open_time: '06:00:00', close_time: '22:00:00', is_closed: false }));
});

courtsRouter.put('/:id/hours', can('courts.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const hours = parse(z.array(z.object({ day_of_week: z.number().int().min(0).max(6), open_time: zTime, close_time: zTime, is_closed: z.boolean() })).length(7), req.body);
  await tx(async (q) => {
    for (const h of hours) {
      if (h.close_time <= h.open_time) throw badRequest('Closing time must be after opening time');
      await q.query(
        `insert into court_operating_hours (court_id, day_of_week, open_time, close_time, is_closed) values ($1,$2,$3,$4,$5)
         on conflict (court_id, day_of_week) do update set open_time = excluded.open_time, close_time = excluded.close_time, is_closed = excluded.is_closed`,
        [id, h.day_of_week, h.open_time, h.close_time, h.is_closed],
      );
    }
    await audit(q, req, 'court.hours_update', 'court', id, { hours });
  });
  res.json({ ok: true });
});

courtsRouter.use('/', crud({
  table: 'courts', entity: 'court', view: ['courts.view'], manage: ['courts.manage'], orderBy: 't.sort_order, t.name', search: ['name', 'code'],
  schema: z.object({
    code: zText, name: zText, description: zOptText.optional(), court_type: z.enum(['indoor', 'outdoor', 'covered']).default('indoor'),
    hourly_rate: zMoney, status: z.enum(['available', 'maintenance', 'closed']).default('available'), is_active: zBool.default(true),
    sort_order: z.coerce.number().int().default(0),
  }),
  softDelete: { column: 'is_active', value: false },
  afterCreate: async (q, row) => {
    await q.query(`insert into court_operating_hours (court_id, day_of_week) select $1, d from generate_series(0, 6) d on conflict do nothing`, [row.id]);
  },
}));

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------
export const reservationsRouter = Router();

reservationsRouter.get('/', can('reservations.view'), async (req, res) => {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (str(req.query.from)) add(`manila_date(r.start_at) >= ?::date`, parse(zDate, req.query.from));
  if (str(req.query.to)) add(`manila_date(r.start_at) <= ?::date`, parse(zDate, req.query.to));
  if (str(req.query.status)) add(`r.status = any(?::text[])`, String(req.query.status).split(','));
  if (str(req.query.court_id)) add(`r.court_id = ?`, parse(zId, req.query.court_id));
  if (str(req.query.player_id)) add(`r.player_id = ?`, parse(zId, req.query.player_id));
  if (str(req.query.q)) add(`(lower(r.customer_name) like ? or lower(r.reference_no) like ?)`.replaceAll('?', `$${params.length + 1}`), `%${String(req.query.q).toLowerCase()}%`);
  if (req.query.unbilled === 'true') {
    where.push(`r.status = any('{pending,confirmed,checked_in,in_progress,completed}') and not exists (select 1 from transactions t where t.reservation_id = r.id) and r.total_amount > 0`);
  }
  const sql = `${RESERVATION_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by r.start_at ${req.query.order === 'desc' ? 'desc' : 'asc'} limit 1000`;
  res.json((await db.query(sql, params)).rows);
});

/** Time-slot grid for one date: which start times are free on each court for the requested duration. */
reservationsRouter.get('/availability', can('reservations.view'), async (req, res) => {
  const date = parse(zDate, req.query.date);
  const duration = Number(req.query.duration ?? 1);
  if (!(duration > 0)) throw badRequest('Invalid duration');
  const settings = await getSettings(db);
  const step = settings.booking_slot_minutes === 30 ? 30 : 60;
  const meta = await one(db, `select extract(dow from $1::date)::int as dow, ($1::date = manila_today()) as is_today, ($1::date < manila_today()) as is_past,
       (extract(hour from now() at time zone 'Asia/Manila') * 60 + extract(minute from now() at time zone 'Asia/Manila'))::int as now_min`, [date]);
  const [courts, hours, booked] = await Promise.all([
    db.query('select * from courts where is_active order by sort_order, name'),
    db.query('select * from court_operating_hours where day_of_week = $1', [meta.dow]),
    db.query(
      `select r.id, r.court_id, r.reference_no, r.customer_name, r.status,
              (extract(epoch from (r.start_at at time zone 'Asia/Manila')::time) / 60)::int as start_min,
              (extract(epoch from (r.start_at at time zone 'Asia/Manila')::time) / 60)::int + (r.duration_hours * 60)::int as end_min
       from reservations r where manila_date(r.start_at) = $1::date and r.status = any($2::text[])`, [date, LIVE_STATUSES]),
  ]);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  res.json({
    date, duration, step,
    courts: courts.rows.map((c) => {
      const h = hours.rows.find((x) => x.court_id === c.id);
      const open = toMin(h?.open_time ?? '06:00'), close = toMin(h?.close_time ?? '22:00');
      const bookings = booked.rows.filter((b) => b.court_id === c.id);
      const bookable = c.status === 'available' && !h?.is_closed && !meta.is_past;
      const slots = [];
      for (let t = open; t < close; t += step) {
        const end = t + duration * 60;
        const taken = bookings.find((b) => t < b.end_min && end > b.start_min);
        const occupant = bookings.find((b) => t >= b.start_min && t < b.end_min);
        slots.push({
          time: fmt(t),
          available: bookable && !taken && end <= close && !(meta.is_today && end <= meta.now_min),
          reservation: occupant ? { id: occupant.id, reference_no: occupant.reference_no, customer_name: occupant.customer_name, status: occupant.status } : null,
        });
      }
      return { id: c.id, name: c.name, status: c.status, court_type: c.court_type, is_closed: !!h?.is_closed, open_time: fmt(open), close_time: fmt(close), slots };
    }),
  });
});

reservationsRouter.post('/quote', can('reservations.view'), async (req, res) => {
  const { court, membership, ...quote } = await quoteCourt(db, parse(bookingSchema, req.body));
  res.json({ ...quote, court_name: court.name, membership: membership ? { plan_name: membership.plan_name, end_date: membership.end_date } : null });
});

/**
 * Create a reservation. With `payments` it is booked and paid (deposit or full) in one atomic step;
 * without, it is saved as Pending and can be paid later at the POS.
 */
reservationsRouter.post('/', can('reservations.manage'), async (req, res) => {
  const body = parse(bookingSchema.extend({
    idempotency_key: z.string().min(8).max(80).optional(),
    payments: checkoutSchema.shape.payments.optional(),
    discount: checkoutSchema.shape.discount,
    approver: checkoutSchema.shape.approver,
  }), req.body);
  const { payments, idempotency_key, discount, approver, ...booking } = body;
  const paying = !!payments?.length;
  if (paying && !has(req.user!, 'pos.use')) throw forbidden('Only cashiers can accept payments. Save the reservation as pending instead');
  if (paying && !idempotency_key) throw badRequest('idempotency_key is required when paying');

  const result = await tx(async (q) => {
    if (paying) {
      const { player_id, customer_name, ...slot } = booking;
      const trx: any = await checkout(q, req.user!, parse(checkoutSchema, {
        idempotency_key, player_id, customer_name, discount, approver, payments, allow_partial: true,
        items: [{ item_type: 'court', booking: { ...slot, is_walk_in: booking.is_walk_in ?? false } }],
      }), req.ip);
      return { reservation: await getReservation(q, trx.reservation_id), transaction: trx };
    }
    const { reservation } = await createReservation(q, req.user!, booking, req.ip);
    return { reservation: await getReservation(q, reservation.id), transaction: null };
  });
  res.status(201).json(result);
});

reservationsRouter.get('/:id', can('reservations.view'), async (req, res) => {
  const row = await getReservation(db, parse(zId, req.params.id));
  const players = await db.query('select p.id, p.player_no, p.full_name from reservation_players rp join players p on p.id = rp.player_id where rp.reservation_id = $1', [row.id]);
  res.json({ ...row, extra_players: players.rows });
});

const TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'checked_in', 'no_show'],
  confirmed: ['checked_in', 'no_show'],
  checked_in: ['in_progress', 'completed'],
  in_progress: ['completed'],
};

reservationsRouter.post('/:id/status', can('reservations.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['confirmed', 'checked_in', 'in_progress', 'completed', 'no_show']) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, 'select * from reservations where id = $1 for update', [id]);
    if (!r) throw notFound('Reservation');
    if (!TRANSITIONS[r.status]?.includes(status)) throw conflict(`A ${r.status.replace('_', ' ')} reservation cannot be marked ${status.replace('_', ' ')}`);
    await q.query(
      `update reservations set status = $2, updated_by = $3,
          checked_in_at = case when $2 = 'checked_in' then now() else checked_in_at end,
          completed_at = case when $2 = 'completed' then now() else completed_at end
       where id = $1`, [id, status, req.user!.id]);
    await audit(q, req, `reservation.${status}`, 'reservation', id, { reference_no: r.reference_no, from: r.status });
    return getReservation(q, id);
  });
  res.json(row);
});

reservationsRouter.post('/:id/cancel', can('reservations.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, 'select * from reservations where id = $1 for update', [id]);
    if (!r) throw notFound('Reservation');
    if (!['pending', 'confirmed', 'checked_in'].includes(r.status)) throw conflict(`A ${r.status.replace('_', ' ')} reservation cannot be cancelled`);
    await q.query(`update reservations set status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_by = $3 where id = $1`, [id, reason, req.user!.id]);
    await audit(q, req, 'reservation.cancel', 'reservation', id, { reference_no: r.reference_no, reason, amount_paid: r.amount_paid });
    return getReservation(q, id);
  });
  // Money already received is NOT returned automatically: it goes through the authorised refund flow.
  res.json(row);
});

reservationsRouter.put('/:id/reschedule', can('reservations.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z.object({ court_id: zId, date: zDate, start_time: zTime, duration_hours: z.coerce.number().positive().max(24) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, 'select * from reservations where id = $1 for update', [id]);
    if (!r) throw notFound('Reservation');
    if (!['pending', 'confirmed'].includes(r.status)) throw conflict(`A ${r.status.replace('_', ' ')} reservation cannot be rescheduled`);
    const billed = await one(q, 'select id from transactions where reservation_id = $1 limit 1', [id]);
    if (billed && Number(d.duration_hours) !== Number(r.duration_hours)) {
      throw conflict('This reservation is already billed, so its duration cannot change. Move it to another slot of the same length, or cancel and rebook');
    }
    const slot = await validateSlot(q, d, { excludeId: id });
    // An already-billed booking keeps the price the customer was charged; an unbilled one is re-priced.
    const quote = billed ? null : await quoteCourt(q, { ...d, player_id: r.player_id });
    await q.query(
      `update reservations set court_id = $2, start_at = $3, end_at = $4, duration_hours = $5, updated_by = $6,
          rate_type = coalesce($7, rate_type), rate_amount = coalesce($8::numeric, rate_amount),
          discount_amount = coalesce($9::numeric, discount_amount), total_amount = coalesce($10::numeric, total_amount)
       where id = $1`,
      [id, d.court_id, slot.start_at, slot.end_at, d.duration_hours, req.user!.id, quote?.rate_type ?? null, quote?.rate_amount ?? null, quote?.discount_amount ?? null, quote?.total ?? null],
    );
    await audit(q, req, 'reservation.reschedule', 'reservation', id, { reference_no: r.reference_no, from: { court_id: r.court_id, start_at: r.start_at }, to: d });
    return getReservation(q, id);
  });
  res.json(row);
});
