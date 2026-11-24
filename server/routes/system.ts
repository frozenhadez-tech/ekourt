// Settings, audit log, notifications and file uploads.
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../audit';
import { can } from '../auth';
import { db, one, tx, type Q } from '../db';
import { badRequest, pageParams, parse, str, zDate, zId } from '../http';
import { getSettings } from '../services/common';

// ---- Settings -------------------------------------------------------------
export const settingsRouter = Router();

const settingsSchema = z.object({
  business_name: z.string().trim().min(1).max(120),
  business_address: z.string().trim().max(300),
  business_contact: z.string().trim().max(120),
  business_tin: z.string().trim().max(60),
  receipt_footer: z.string().trim().max(300),
  vat_registered: z.boolean(),
  vat_rate: z.coerce.number().min(0).max(50),
  sc_pwd_discount_rate: z.coerce.number().min(0).max(100),
  sc_pwd_eligible_types: z.array(z.enum(['court', 'product', 'service', 'equipment', 'membership', 'charge'])),
  member_discount_types: z.array(z.enum(['court', 'product', 'service', 'equipment'])),
  require_open_shift: z.boolean(),
  membership_expiry_notice_days: z.coerce.number().int().min(0).max(90),
  booking_slot_minutes: z.coerce.number().refine((v) => v === 30 || v === 60, 'Must be 30 or 60'),
  max_advance_booking_days: z.coerce.number().int().min(0).max(365),
  duration_months: z.object({ monthly: z.coerce.number().int().min(1), quarterly: z.coerce.number().int().min(1), semi_annual: z.coerce.number().int().min(1), annual: z.coerce.number().int().min(1) }),
}).partial();

settingsRouter.get('/', async (_req, res) => res.json(await getSettings(db)));

settingsRouter.put('/', can('settings.manage'), async (req, res) => {
  const d = parse(settingsSchema, req.body) as Record<string, unknown>;
  await tx(async (q) => {
    const before: any = await getSettings(q);
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(d)) {
      if (value === undefined || JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      await q.query(`insert into business_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
      changes[key] = { from: before[key], to: value };
    }
    if (Object.keys(changes).length) await audit(q, req, 'settings.update', 'settings', null, { changes });
  });
  res.json(await getSettings(db));
});

// ---- Audit log (read-only) ------------------------------------------------
export const auditRouter = Router();

auditRouter.get('/', can('audit.view'), async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, 500);
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (str(req.query.from)) add('manila_date(created_at) >= ?::date', parse(zDate, req.query.from));
  if (str(req.query.to)) add('manila_date(created_at) <= ?::date', parse(zDate, req.query.to));
  if (str(req.query.employee_id)) add('employee_id = ?', parse(zId, req.query.employee_id));
  if (str(req.query.action)) add('action like ?', `${req.query.action}%`);
  if (str(req.query.q)) add(`(lower(action) like ? or lower(coalesce(employee_name, '')) like ? or lower(details::text) like ?)`, `%${String(req.query.q).toLowerCase()}%`);
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const rows = await db.query(`select * from audit_logs ${w} order by created_at desc limit ${limit} offset ${offset}`, params);
  const count = await one(db, `select count(*)::int as n from audit_logs ${w}`, params);
  const actions = await db.query(`select distinct split_part(action, '.', 1) as area from audit_logs order by 1`);
  res.json({ rows: rows.rows, count: count.n, page, limit, areas: actions.rows.map((r) => r.area) });
});

// ---- Notifications --------------------------------------------------------
export const notificationsRouter = Router();

notificationsRouter.get('/', async (_req, res) => {
  const rows = await db.query('select * from notifications order by is_read, created_at desc limit 60');
  const unread = await one(db, 'select count(*)::int as n from notifications where not is_read');
  res.json({ rows: rows.rows, unread: unread.n });
});
notificationsRouter.post('/read', async (req, res) => {
  const { id } = parse(z.object({ id: zId.optional() }), req.body ?? {});
  await db.query('update notifications set is_read = true where not is_read and ($1::uuid is null or id = $1)', [id ?? null]);
  res.json({ ok: true });
});

/** Housekeeping run at boot and hourly: expire memberships and raise renewal / stock / rental alerts. */
export async function runMaintenance(q: Q = db) {
  await q.query(`update player_memberships set status = 'expired', status_reason = 'Term ended', status_changed_at = now()
                 where status = 'active' and end_date < manila_today()`);
  const days = (await getSettings(q)).membership_expiry_notice_days;
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'membership_expiring', 'Membership expiring soon',
            p.full_name || '''s ' || mp.name || ' expires on ' || to_char(pm.end_date, 'Mon DD, YYYY') || '. Offer a renewal.',
            'membership', pm.id, 'mem-exp-' || pm.id
     from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
     where pm.status = 'active' and pm.end_date between manila_today() and manila_today() + $1::int
     on conflict (dedupe_key) do nothing`, [days]);
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'membership_expired', 'Membership expired', p.full_name || '''s ' || mp.name || ' expired on ' || to_char(pm.end_date, 'Mon DD, YYYY') || '.',
            'membership', pm.id, 'mem-expired-' || pm.id
     from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
     where pm.status = 'expired' and pm.end_date >= manila_today() - 14
     on conflict (dedupe_key) do nothing`);
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'low_stock', 'Low stock', name || ' is down to ' || stock_qty || ' (minimum ' || min_stock || ').', 'product', id,
            'low-stock-' || id || '-' || to_char(manila_today(), 'IYYY-IW')
     from products where status = 'active' and stock_qty <= min_stock
     on conflict (dedupe_key) do nothing`);
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'rental_overdue', 'Rental overdue', er.customer_name || ' has not returned ' || er.quantity || ' x ' || e.name || ' (' || er.rental_no || ').',
            'equipment_rental', er.id, 'rental-overdue-' || er.id
     from equipment_rentals er join equipment e on e.id = er.equipment_id
     where er.status = 'rented' and er.expected_return_at < now() - interval '15 minutes'
     on conflict (dedupe_key) do nothing`);
}

// ---- Uploads (player photos, product images, expense receipts) ---------------
export const uploadsRouter = Router();
const ALLOWED: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// Files are stored in the database (table uploaded_files), not on disk, so serverless hosts work.
// 4 MB keeps the request under Vercel's 4.5 MB body limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED[file.mimetype] ? cb(null, true) : cb(badRequest('Only JPG, PNG, WEBP or PDF files are allowed'))),
});

uploadsRouter.post('/', can('players.manage', 'inventory.manage', 'expenses.create', 'expenses.approve'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('No file received');
  // Server-generated random name: the client's filename is never stored or served.
  const name = crypto.randomBytes(16).toString('hex') + ALLOWED[req.file.mimetype];
  await tx(async (q) => {
    await q.query('insert into uploaded_files (name, mime_type, size_bytes, data, uploaded_by) values ($1,$2,$3,$4,$5)',
      [name, req.file!.mimetype, req.file!.size, req.file!.buffer, req.user?.id ?? null]);
    await audit(q, req, 'file.upload', 'file', null, { name, size: req.file!.size, type: req.file!.mimetype });
  });
  res.status(201).json({ url: `/uploads/${name}` });
});

/** Authenticated download. */
uploadsRouter.get('/:name', async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(name)) throw badRequest('Invalid file name');
  const file = await one(db, 'select mime_type, data from uploaded_files where name = $1', [name]);
  if (!file) { res.status(404).json({ error: 'File not found' }); return; }
  res.set({ 'Content-Type': file.mime_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(file.data);
});
