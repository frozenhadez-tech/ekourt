// Configuration tables: products, services, rental equipment, price lists, plans, discounts.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit';
import { can } from '../auth';
import { crud } from '../crud';
import { db, one, tx } from '../db';
import { badRequest, conflict, notFound, parse, str, zBool, zDate, zId, zMoney, zOptDate, zOptId, zOptText, zOptTime, zText } from '../http';
import { numbers } from '../services/common';

const nonNeg = z.coerce.number().int().min(0);
const VIEW = ['catalog.view'] as const;

export const productsRouter = crud({
  table: 'products', entity: 'product', view: [...VIEW], manage: ['inventory.manage'], orderBy: 't.name', search: ['name', 'code'],
  select: `t.*, c.name as category_name, s.name as supplier_name, (t.stock_qty <= t.min_stock) as low_stock`,
  joins: 'left join product_categories c on c.id = t.category_id left join suppliers s on s.id = t.supplier_id',
  // stock_qty is deliberately absent: stock only changes through inventory movements.
  schema: z.object({
    code: zText, name: zText, category_id: zOptId.optional(), description: zOptText.optional(), cost_price: zMoney, selling_price: zMoney,
    min_stock: nonNeg.default(0), supplier_id: zOptId.optional(), image_url: zOptText.optional(), status: z.enum(['active', 'archived']).default('active'),
  }),
  softDelete: { column: 'status', value: 'archived' },
});

export const categoriesRouter = crud({
  table: 'product_categories', entity: 'product_category', view: [...VIEW], manage: ['inventory.manage'], orderBy: 't.name', search: ['name'],
  schema: z.object({ name: zText, description: zOptText.optional(), is_active: zBool.default(true) }),
});

export const suppliersRouter = crud({
  table: 'suppliers', entity: 'supplier', view: [...VIEW], manage: ['inventory.manage'], orderBy: 't.name', search: ['name', 'contact_person'],
  schema: z.object({ name: zText, contact_person: zOptText.optional(), contact_number: zOptText.optional(), email: zOptText.optional(), address: zOptText.optional(), is_active: zBool.default(true) }),
});

export const servicesRouter = crud({
  table: 'services', entity: 'service', view: [...VIEW], manage: ['services.manage'], orderBy: 't.category, t.name', search: ['name', 'code', 'category'],
  schema: z.object({
    code: zText, name: zText, description: zOptText.optional(), category: zText.default('general'),
    charge_method: z.enum(['per_hour', 'per_person', 'per_session', 'per_item', 'fixed']).default('fixed'), price: zMoney, is_active: zBool.default(true),
  }),
  softDelete: { column: 'is_active', value: false },
});

export const ratesRouter = crud({
  table: 'court_rates', entity: 'court_rate', view: [...VIEW], manage: ['pricing.manage'], orderBy: 't.rate_type, t.duration_hours', search: ['name', 'rate_type'],
  schema: z.object({
    name: zText, rate_type: z.enum(['weekday', 'weekend', 'holiday', 'peak', 'off_peak', 'promo']), duration_hours: z.coerce.number().positive().max(24),
    price: zMoney, day_scope: z.enum(['all', 'weekday', 'weekend']).default('all'), start_time: zOptTime.optional(), end_time: zOptTime.optional(),
    valid_from: zOptDate.optional(), valid_to: zOptDate.optional(), is_active: zBool.default(true),
  }),
});

export const holidaysRouter = crud({
  table: 'holidays', entity: 'holiday', view: [...VIEW], manage: ['pricing.manage'], orderBy: 't.holiday_date',
  schema: z.object({ holiday_date: zDate, name: zText }),
});

export const discountsRouter = crud({
  table: 'discounts', entity: 'discount', view: [...VIEW], manage: ['discounts.manage'], orderBy: 't.name', search: ['name', 'code'],
  schema: z.object({
    code: z.preprocess((v) => (v === '' || v == null ? null : String(v).trim().toUpperCase()), z.string().max(40).nullable()).optional(),
    name: zText, discount_type: z.enum(['percentage', 'fixed', 'promo', 'senior', 'pwd', 'special_event']),
    value_type: z.enum(['percent', 'fixed']).default('percent'), value: zMoney,
    applies_to: z.array(z.enum(['court', 'product', 'service', 'equipment', 'membership', 'charge'])).default([]),
    min_amount: zMoney.default('0.00'), valid_from: zOptDate.optional(), valid_to: zOptDate.optional(),
    usage_limit: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().int().min(1).nullable()).optional(),
    requires_approval: zBool.default(false), stackable_with_membership: zBool.default(false), is_active: zBool.default(true),
  }),
  softDelete: { column: 'is_active', value: false },
});

export const expenseCategoriesRouter = crud({
  table: 'expense_categories', entity: 'expense_category', view: ['expenses.view', 'expenses.create'], manage: ['expenses.approve'], orderBy: 't.name',
  schema: z.object({ name: zText, is_active: zBool.default(true) }),
});

// ---- Membership plans (with benefit lines) --------------------------------
export const plansRouter = Router();
const planSchema = z.object({
  code: zText, name: zText, description: zOptText.optional(), monthly_price: zMoney, court_discount_percent: z.coerce.number().min(0).max(100),
  free_paddle_rentals_per_month: nonNeg.default(0), priority_booking: zBool.default(false), advance_booking_days: nonNeg.default(7),
  sort_order: z.coerce.number().int().default(0), is_active: zBool.default(true),
});
const benefitsSchema = z.object({ benefits: z.array(zText).max(30) });

plansRouter.get('/', can('catalog.view', 'memberships.view'), async (_req, res) => {
  const { rows } = await db.query(`
    select p.*, coalesce((select json_agg(b.description order by b.sort_order) from membership_benefits b where b.plan_id = p.id), '[]') as benefits,
           (select count(*)::int from player_memberships pm where pm.plan_id = p.id and pm.status = 'active' and pm.end_date >= manila_today()) as active_members
    from membership_plans p order by p.sort_order, p.monthly_price`);
  res.json(rows);
});
plansRouter.put('/:id/benefits', can('pricing.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { benefits } = parse(benefitsSchema, req.body);
  await tx(async (q) => {
    await q.query('delete from membership_benefits where plan_id = $1', [id]);
    for (const [i, b] of benefits.entries()) await q.query('insert into membership_benefits (plan_id, description, sort_order) values ($1,$2,$3)', [id, b, i + 1]);
    await audit(q, req, 'membership_plan.benefits_update', 'membership_plan', id, { benefits });
  });
  res.json({ ok: true });
});
plansRouter.use('/', crud({ table: 'membership_plans', entity: 'membership_plan', view: ['catalog.view'], manage: ['pricing.manage'], schema: planSchema, softDelete: { column: 'is_active', value: false } }));

// ---- Rental equipment -----------------------------------------------------
export const equipmentRouter = Router();
const equipmentSchema = z.object({
  code: zText, name: zText, description: zOptText.optional(), rental_rate: zMoney,
  charge_method: z.enum(['per_hour', 'per_session', 'per_use']).default('per_session'),
  entitlement_type: z.preprocess((v) => (v === '' || v == null ? null : v), z.enum(['free_paddle_rental']).nullable()).optional(),
  is_active: zBool.default(true),
});

/** Stock count change for rental equipment (new units bought, damaged units written off or repaired). */
equipmentRouter.post('/:id/adjust', can('inventory.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z.object({ total_qty: nonNeg, damaged_qty: nonNeg, missing_qty: nonNeg, notes: zOptText.optional() }), req.body);
  const row = await tx(async (q) => {
    const e = await one(q, 'select * from equipment where id = $1 for update', [id]);
    if (!e) throw notFound('Equipment');
    const out = (await one(q, `select coalesce(sum(quantity - qty_returned - qty_damaged - qty_missing), 0)::int as n from equipment_rentals where equipment_id = $1 and status = 'rented'`, [id])).n;
    const available = d.total_qty - d.damaged_qty - d.missing_qty - out;
    if (available < 0) throw badRequest(`${out} unit(s) are currently rented out, so total must be at least ${out + d.damaged_qty + d.missing_qty}`);
    const after = await one(q, 'update equipment set total_qty = $2, damaged_qty = $3, missing_qty = $4, available_qty = $5 where id = $1 returning *', [id, d.total_qty, d.damaged_qty, d.missing_qty, available]);
    await audit(q, req, 'equipment.adjust', 'equipment', id, { before: { total: e.total_qty, available: e.available_qty, damaged: e.damaged_qty, missing: e.missing_qty }, after: { ...d, available } });
    return after;
  });
  res.json(row);
});
equipmentRouter.use('/', crud({
  table: 'equipment', entity: 'equipment', view: [...VIEW], manage: ['inventory.manage'], orderBy: 't.name', search: ['name', 'code'], schema: equipmentSchema,
  select: `t.*, (t.total_qty - t.available_qty - t.damaged_qty - t.missing_qty) as rented_qty`,
  softDelete: { column: 'is_active', value: false },
}));

// ---- Equipment rentals ----------------------------------------------------
export const rentalsRouter = Router();

rentalsRouter.get('/', can('catalog.view'), async (req, res) => {
  const status = str(req.query.status);
  const { rows } = await db.query(
    `select er.*, e.name as equipment_name, e.code as equipment_code, p.player_no, t.transaction_no, ie.full_name as issued_by_name,
            (er.status = 'rented' and er.expected_return_at is not null and er.expected_return_at < now()) as overdue
     from equipment_rentals er join equipment e on e.id = er.equipment_id
     left join players p on p.id = er.player_id left join transactions t on t.id = er.transaction_id left join employees ie on ie.id = er.issued_by
     where ($1::text is null or er.status = $1) order by er.rented_at desc limit 500`, [status ?? null]);
  res.json(rows);
});

rentalsRouter.post('/:id/return', can('rentals.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z.object({ qty_damaged: nonNeg.default(0), qty_missing: nonNeg.default(0), notes: zOptText.optional() }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, 'select * from equipment_rentals where id = $1 for update', [id]);
    if (!r) throw notFound('Rental');
    if (r.status !== 'rented') throw conflict('This rental has already been returned');
    if (d.qty_damaged + d.qty_missing > r.quantity) throw badRequest('Damaged and missing units exceed the rented quantity');
    const good = r.quantity - d.qty_damaged - d.qty_missing;
    await q.query('update equipment set available_qty = available_qty + $2, damaged_qty = damaged_qty + $3, missing_qty = missing_qty + $4 where id = $1', [r.equipment_id, good, d.qty_damaged, d.qty_missing]);
    const after = await one(
      q,
      `update equipment_rentals set status = $2, returned_at = now(), qty_returned = $3, qty_damaged = $4, qty_missing = $5, received_by = $6, notes = coalesce($7, notes)
       where id = $1 returning *`,
      [id, d.qty_damaged + d.qty_missing > 0 ? 'returned_with_issues' : 'returned', good, d.qty_damaged, d.qty_missing, req.user!.id, d.notes ?? null],
    );
    await audit(q, req, 'rental.return', 'equipment_rental', id, { rental_no: r.rental_no, good, damaged: d.qty_damaged, missing: d.qty_missing });
    return after;
  });
  res.json(row);
});

// ---- Inventory movements --------------------------------------------------
export const inventoryRouter = Router();

inventoryRouter.get('/movements', can('catalog.view'), async (req, res) => {
  const productId = str(req.query.product_id);
  const { rows } = await db.query(
    `select im.*, p.name as product_name, p.code as product_code, e.full_name as created_by_name, t.transaction_no
     from inventory_movements im join products p on p.id = im.product_id
     left join employees e on e.id = im.created_by left join transactions t on t.id = im.transaction_id
     where ($1::uuid is null or im.product_id = $1) order by im.created_at desc limit 500`, [productId ?? null]);
  res.json(rows);
});

inventoryRouter.post('/movements', can('inventory.manage'), async (req, res) => {
  const d = parse(z.object({
    product_id: zId,
    movement_type: z.enum(['stock_in', 'stock_out', 'adjustment']),
    quantity: z.coerce.number().int().min(0).max(1_000_000), // adjustment: the new counted quantity
    unit_cost: zMoney.optional(),
    notes: zOptText.optional(),
  }), req.body);
  if (d.movement_type !== 'adjustment' && d.quantity === 0) throw badRequest('Quantity must be greater than zero');
  if (d.movement_type !== 'stock_in' && !d.notes) throw badRequest('A reason is required for stock-out and adjustments');
  const row = await tx(async (q) => {
    const p = await one(q, 'select * from products where id = $1 for update', [d.product_id]);
    if (!p) throw notFound('Product');
    const delta = d.movement_type === 'stock_in' ? d.quantity : d.movement_type === 'stock_out' ? -d.quantity : d.quantity - p.stock_qty;
    const balance = p.stock_qty + delta;
    if (balance < 0) throw conflict(`Only ${p.stock_qty} in stock`);
    await q.query('update products set stock_qty = $2, cost_price = coalesce($3::numeric, cost_price) where id = $1', [p.id, balance, d.movement_type === 'stock_in' ? d.unit_cost ?? null : null]);
    const mv = await one(
      q,
      `insert into inventory_movements (product_id, movement_type, quantity, balance_after, unit_cost, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [p.id, d.movement_type, delta, balance, d.unit_cost ?? p.cost_price, d.notes ?? null, req.user!.id],
    );
    await audit(q, req, `inventory.${d.movement_type}`, 'product', p.id, { product: p.name, from: p.stock_qty, to: balance, delta, notes: d.notes });
    return mv;
  });
  res.status(201).json(row);
});

// ---- Memberships (sales go through POS checkout; this manages their lifecycle) ----
export const membershipsRouter = Router();

membershipsRouter.get('/', can('memberships.view'), async (req, res) => {
  const status = str(req.query.status);
  const { rows } = await db.query(
    `select * from (
       select pm.*, p.player_no, p.full_name as player_name, p.contact_number, p.photo_url, mp.name as plan_name, mp.code as plan_code,
              mp.court_discount_percent, mp.free_paddle_rentals_per_month, t.transaction_no,
              (pm.end_date - manila_today()) as days_left,
              case when pm.status = 'active' and pm.end_date < manila_today() then 'expired' else pm.status end as effective_status,
              coalesce((select sum(du.amount) from discount_usage du where du.membership_id = pm.id), 0) as discounts_used,
              coalesce((select me.quantity_used from membership_entitlements me where me.membership_id = pm.id
                        and me.period_start = date_trunc('month', manila_today())::date limit 1), 0) as free_rentals_used
       from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
       left join transactions t on t.id = pm.transaction_id
       where ($2::uuid is null or pm.player_id = $2)) x
     where ($1::text is null or x.effective_status = $1) or ($1 = 'expiring' and x.effective_status = 'active' and x.days_left <= $3)
     order by x.created_at desc limit 1000`,
    [status ?? null, str(req.query.player_id) ?? null, Number(req.query.days ?? 7)]);
  res.json(rows);
});

membershipsRouter.post('/:id/status', can('memberships.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z.object({ action: z.enum(['suspend', 'resume', 'cancel']), reason: z.string().trim().min(3).max(500) }), req.body);
  const row = await tx(async (q) => {
    const mem = await one(q, 'select * from player_memberships where id = $1 for update', [id]);
    if (!mem) throw notFound('Membership');
    const allowed = { suspend: ['active'], resume: ['suspended'], cancel: ['active', 'suspended'] }[d.action];
    if (!allowed.includes(mem.status)) throw conflict(`A ${mem.status} membership cannot be ${d.action === 'resume' ? 'resumed' : d.action + 'ed'}`);
    const status = { suspend: 'suspended', resume: 'active', cancel: 'cancelled' }[d.action];
    const after = await one(q, 'update player_memberships set status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 where id = $1 returning *', [id, status, d.reason, req.user!.id]);
    await audit(q, req, `membership.${d.action}`, 'membership', id, { membership_no: mem.membership_no, reason: d.reason });
    return after;
  });
  res.json(row);
});

export { numbers };
