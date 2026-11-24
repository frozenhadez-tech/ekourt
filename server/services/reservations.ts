import { z } from 'zod';
import { audit } from '../audit';
import { one, type Q } from '../db';
import { badRequest, conflict, notFound, zDate, zId, zOptId, zOptText, zTime, type AuthUser } from '../http';
import { getSettings, numbers } from './common';
import { quoteCourt } from './pricing';

export const LIVE_STATUSES = ['pending', 'confirmed', 'checked_in', 'in_progress'];

export const bookingSchema = z.object({
  court_id: zId,
  date: zDate,
  start_time: zTime,
  duration_hours: z.coerce.number().positive().max(24),
  player_id: zOptId.optional(),
  customer_name: zOptText.optional(),
  customer_contact: zOptText.optional(),
  notes: zOptText.optional(),
  is_walk_in: z.boolean().optional(),
  extra_player_ids: z.array(zId).max(20).optional(),
});
export type BookingInput = z.infer<typeof bookingSchema>;

export const RESERVATION_SELECT = `
  select r.*, c.name as court_name, p.player_no, p.full_name as player_name,
         to_char(r.start_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
         to_char(r.start_at at time zone 'Asia/Manila', 'HH24:MI') as start_time,
         to_char(r.end_at at time zone 'Asia/Manila', 'HH24:MI') as end_time,
         (r.total_amount - r.amount_paid) as balance,
         ce.full_name as created_by_name, ue.full_name as updated_by_name,
         (select t.id from transactions t where t.reservation_id = r.id order by t.created_at limit 1) as transaction_id
  from reservations r
  join courts c on c.id = r.court_id
  left join players p on p.id = r.player_id
  left join employees ce on ce.id = r.created_by
  left join employees ue on ue.id = r.updated_by`;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Validates the slot against court status, operating hours, booking window and existing bookings. */
export async function validateSlot(q: Q, input: BookingInput, opts: { excludeId?: string; advanceDays?: number } = {}) {
  // Row lock serialises concurrent bookings for the same court; the exclusion constraint is the final guard.
  const court = await one(q, 'select * from courts where id = $1 for update', [input.court_id]);
  if (!court) throw notFound('Court');
  if (!court.is_active || court.status === 'closed') throw conflict(`${court.name} is closed`);
  if (court.status === 'maintenance') throw conflict(`${court.name} is under maintenance`);

  const slot = await one(
    q,
    `select extract(dow from $1::date)::int as dow, manila_today()::text as today,
            ($1::date - manila_today()) as days_ahead,
            (($1::date + $2::time) at time zone 'Asia/Manila') as start_at,
            (($1::date + $2::time + ($3 || ' minutes')::interval) at time zone 'Asia/Manila') as end_at,
            (($1::date + $2::time + ($3 || ' minutes')::interval) at time zone 'Asia/Manila') <= now() as is_past`,
    [input.date, input.start_time, Math.round(input.duration_hours * 60)],
  );
  if (slot.days_ahead < 0 || slot.is_past) throw badRequest('That time slot has already passed');
  if (opts.advanceDays !== undefined && slot.days_ahead > opts.advanceDays) {
    throw badRequest(`Bookings can be made at most ${opts.advanceDays} days in advance for this customer`);
  }

  const hours = await one(q, 'select * from court_operating_hours where court_id = $1 and day_of_week = $2', [input.court_id, slot.dow]);
  if (hours?.is_closed) throw conflict(`${court.name} is closed on that day`);
  const open = toMin(hours?.open_time ?? '00:00');
  const close = toMin(hours?.close_time ?? '23:59');
  const start = toMin(input.start_time);
  const end = start + Math.round(input.duration_hours * 60);
  if (start < open || end > close) {
    throw badRequest(`${court.name} is open ${String(hours?.open_time ?? '00:00').slice(0, 5)}–${String(hours?.close_time ?? '24:00').slice(0, 5)} on that day`);
  }

  const clash = await one(
    q,
    `select reference_no from reservations
     where court_id = $1 and status = any($2::text[]) and tstzrange(start_at, end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
       and ($5::uuid is null or id <> $5) limit 1`,
    [input.court_id, LIVE_STATUSES, slot.start_at, slot.end_at, opts.excludeId ?? null],
  );
  if (clash) throw conflict(`${court.name} is already booked for that time (${clash.reference_no})`, 'SLOT_TAKEN');
  return { court, start_at: slot.start_at as Date, end_at: slot.end_at as Date };
}

/** Creates a reservation inside the caller's transaction. Pricing is always computed server-side. */
export async function createReservation(q: Q, user: AuthUser, input: BookingInput, ip?: string) {
  let customerName = input.customer_name ?? null;
  let contact = input.customer_contact ?? null;
  if (input.player_id) {
    const player = await one(q, 'select * from players where id = $1', [input.player_id]);
    if (!player) throw notFound('Player');
    if (player.status === 'banned') throw conflict(`${player.full_name} is banned and cannot book`);
    customerName = player.full_name;
    contact = contact ?? player.contact_number;
  }
  if (!customerName) customerName = 'Walk-in Customer';

  const quote = await quoteCourt(q, input);
  const settings = await getSettings(q);
  const advanceDays = Math.max(settings.max_advance_booking_days, quote.membership?.advance_booking_days ?? 0);
  const slot = await validateSlot(q, input, { advanceDays });

  const row = await one(
    q,
    `insert into reservations (reference_no, player_id, customer_name, customer_contact, court_id, start_at, end_at, duration_hours,
        status, is_walk_in, rate_type, rate_amount, discount_amount, total_amount, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15,$15) returning *`,
    [await numbers.reservation(q), input.player_id ?? null, customerName, contact, input.court_id, slot.start_at, slot.end_at,
      input.duration_hours, input.is_walk_in ?? false, quote.rate_type, quote.rate_amount, quote.discount_amount, quote.total,
      input.notes ?? null, user.id],
  );
  for (const pid of new Set(input.extra_player_ids ?? [])) {
    if (pid !== input.player_id) await q.query('insert into reservation_players (reservation_id, player_id) values ($1, $2)', [row.id, pid]);
  }
  await audit(q, { user, ip }, 'reservation.create', 'reservation', row.id, {
    reference_no: row.reference_no, court: slot.court.name, date: input.date, start_time: input.start_time,
    duration_hours: input.duration_hours, total: quote.total,
  });
  return { reservation: row, quote };
}

export async function getReservation(q: Q, id: string) {
  const row = await one(q, `${RESERVATION_SELECT} where r.id = $1`, [id]);
  if (!row) throw notFound('Reservation');
  return row;
}
