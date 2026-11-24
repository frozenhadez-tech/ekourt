import { Router } from 'express';
import { z } from 'zod';
import { audit, diff } from '../audit';
import { can } from '../auth';
import { db, one, tx, type Q } from '../db';
import { conflict, notFound, pageParams, parse, str, zId, zOptDate, zOptText, zText } from '../http';
import { numbers } from '../services/common';
import { RESERVATION_SELECT } from '../services/reservations';

export const playersRouter = Router();

const schema = z.object({
  full_name: zText,
  gender: z.preprocess((v) => (v === '' ? null : v), z.enum(['male', 'female', 'other']).nullable()).optional(),
  birthday: zOptDate.optional(),
  contact_number: zOptText.optional(),
  email: z.preprocess((v) => (v === '' || v == null ? null : String(v).trim().toLowerCase()), z.string().email().nullable()).optional(),
  address: zOptText.optional(),
  emergency_contact_name: zOptText.optional(),
  emergency_contact_number: zOptText.optional(),
  status: z.enum(['active', 'inactive', 'banned']).optional(),
  photo_url: zOptText.optional(),
  notes: zOptText.optional(),
});

// Effective membership status is derived from dates, so an expired plan never shows as active.
const PLAYER_SELECT = `
  select p.*, m.id as membership_id, m.membership_no, m.end_date as membership_end, mp.name as plan_name, mp.code as plan_code,
         case when m.id is null then 'none'
              when m.status = 'suspended' then 'suspended'
              when m.end_date < manila_today() then 'expired'
              else 'active' end as membership_status
  from players p
  left join lateral (
    select * from player_memberships pm where pm.player_id = p.id and pm.status in ('active','suspended','expired')
    order by (pm.status in ('active','suspended')) desc, pm.end_date desc limit 1
  ) m on true
  left join membership_plans mp on mp.id = m.plan_id`;

async function assertNoDuplicate(q: Q, d: { email?: string | null; contact_number?: string | null }, excludeId?: string) {
  if (d.email) {
    const dup = await one(q, 'select player_no, full_name from players where lower(email) = lower($1) and ($2::uuid is null or id <> $2)', [d.email, excludeId ?? null]);
    if (dup) throw conflict(`Email is already registered to ${dup.full_name} (${dup.player_no})`, 'DUPLICATE_PLAYER');
  }
  if (d.contact_number) {
    const dup = await one(q, 'select player_no, full_name from players where contact_number = $1 and ($2::uuid is null or id <> $2)', [d.contact_number, excludeId ?? null]);
    if (dup) throw conflict(`Contact number is already registered to ${dup.full_name} (${dup.player_no})`, 'DUPLICATE_PLAYER');
  }
}

playersRouter.get('/', can('players.view'), async (req, res) => {
  const { limit, offset } = pageParams(req.query, 500);
  const params: unknown[] = [];
  const where: string[] = [];
  const q = str(req.query.q);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(p.full_name) like $${params.length} or lower(p.player_no) like $${params.length} or p.contact_number like $${params.length} or lower(p.email) like $${params.length})`);
  }
  const status = str(req.query.status);
  if (status) { params.push(status); where.push(`p.status = $${params.length}`); }
  const membership = str(req.query.membership);
  const sql = `select * from (${PLAYER_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''}) x
               ${membership ? `where x.membership_status = $${params.push(membership)}` : ''}
               order by x.created_at desc limit ${limit} offset ${offset}`;
  res.json((await db.query(sql, params)).rows);
});

playersRouter.post('/', can('players.manage'), async (req, res) => {
  const d = parse(schema, req.body);
  const row = await tx(async (q) => {
    await assertNoDuplicate(q, d);
    const created = await one(
      q,
      `insert into players (player_no, full_name, gender, birthday, contact_number, email, address, emergency_contact_name,
          emergency_contact_number, status, photo_url, notes, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [await numbers.player(q), d.full_name, d.gender ?? null, d.birthday ?? null, d.contact_number ?? null, d.email ?? null, d.address ?? null,
        d.emergency_contact_name ?? null, d.emergency_contact_number ?? null, d.status ?? 'active', d.photo_url ?? null, d.notes ?? null, req.user!.id],
    );
    await audit(q, req, 'player.register', 'player', created.id, { player_no: created.player_no, full_name: created.full_name });
    return created;
  });
  res.status(201).json(row);
});

playersRouter.put('/:id', can('players.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(schema.partial(), req.body) as Record<string, unknown>;
  const row = await tx(async (q) => {
    const before = await one(q, 'select * from players where id = $1 for update', [id]);
    if (!before) throw notFound('Player');
    await assertNoDuplicate(q, d as any, id);
    const keys = Object.keys(d).filter((k) => d[k] !== undefined);
    if (!keys.length) return before;
    const after = await one(q, `update players set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [id, ...keys.map((k) => d[k])]);
    await audit(q, req, 'player.update', 'player', id, { changes: diff(before, after) });
    return after;
  });
  res.json(row);
});

/** Full profile with booking, payment, rental and membership history. */
playersRouter.get('/:id', can('players.view'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const player = await one(db, `${PLAYER_SELECT} where p.id = $1`, [id]);
  if (!player) throw notFound('Player');
  const [reservations, transactions, payments, rentals, memberships] = await Promise.all([
    db.query(`${RESERVATION_SELECT} where r.player_id = $1 or r.id in (select reservation_id from reservation_players where player_id = $1) order by r.start_at desc limit 100`, [id]),
    db.query(`select id, transaction_no, transaction_type, total, amount_paid, balance, status, created_at from transactions where player_id = $1 order by created_at desc limit 100`, [id]),
    db.query(`select p.id, p.method, p.amount, p.kind, p.created_at, t.transaction_no from payments p join transactions t on t.id = p.transaction_id where t.player_id = $1 order by p.created_at desc limit 100`, [id]),
    db.query(`select er.*, e.name as equipment_name from equipment_rentals er join equipment e on e.id = er.equipment_id where er.player_id = $1 order by er.rented_at desc limit 100`, [id]),
    db.query(`select pm.*, mp.name as plan_name from player_memberships pm join membership_plans mp on mp.id = pm.plan_id where pm.player_id = $1 order by pm.created_at desc`, [id]),
  ]);
  res.json({ ...player, reservations: reservations.rows, transactions: transactions.rows, payments: payments.rows, rentals: rentals.rows, memberships: memberships.rows });
});
