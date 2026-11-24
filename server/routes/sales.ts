// Transactions, POS checkout, refunds, cashier shifts and expenses.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit';
import { can, has } from '../auth';
import { db, one, tx, type Q } from '../db';
import { badRequest, conflict, forbidden, notFound, pageParams, parse, str, zDate, zId, zMoney, zOptText } from '../http';
import { D, m } from '../money';
import { PAYMENT_METHODS } from '../../shared/permissions';
import { addPayment, addPaymentSchema, checkout, checkoutSchema, getTransaction, PreviewRollback, refund, refundSchema } from '../services/checkout';
import { numbers, openShift } from '../services/common';

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
export const transactionsRouter = Router();

transactionsRouter.post('/checkout', can('pos.use'), async (req, res) => {
  const input = parse(checkoutSchema, req.body);
  try {
    const result = await tx((q) => checkout(q, req.user!, input, req.ip));
    res.status(input.preview ? 200 : 201).json(result);
  } catch (err: any) {
    if (err instanceof PreviewRollback) return void res.json(err.payload); // preview: computed, then rolled back
    // Two identical submissions racing: the unique idempotency key lets exactly one through.
    if (err?.code === '23505' && String(err.constraint).includes('idempotency')) {
      const existing = await one(db, 'select id from transactions where idempotency_key = $1', [input.idempotency_key]);
      if (existing) return void res.json({ ...(await getTransaction(db, existing.id)), replayed: true });
    }
    throw err;
  }
});

transactionsRouter.get('/', can('transactions.view'), async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, 5000);
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (str(req.query.from)) add(`manila_date(t.created_at) >= ?::date`, parse(zDate, req.query.from));
  if (str(req.query.to)) add(`manila_date(t.created_at) <= ?::date`, parse(zDate, req.query.to));
  if (str(req.query.cashier_id)) add(`t.cashier_id = ?`, parse(zId, req.query.cashier_id));
  if (str(req.query.status)) add(`t.status = ?`, req.query.status);
  if (str(req.query.type)) add(`t.transaction_type = ?`, req.query.type);
  if (str(req.query.shift_id)) add(`t.shift_id = ?`, parse(zId, req.query.shift_id));
  if (str(req.query.method)) add(`exists (select 1 from payments p where p.transaction_id = t.id and p.method = ?)`, req.query.method);
  if (str(req.query.q)) add(`(lower(t.transaction_no) like ? or lower(t.customer_name) like ?)`, `%${String(req.query.q).toLowerCase()}%`);
  // Cashiers see their own sales; supervisors see everything.
  if (!has(req.user!, 'shifts.view_all') && !has(req.user!, 'reports.view')) add(`t.cashier_id = ?`, req.user!.id);
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const [rows, total] = await Promise.all([
    db.query(
      `select t.*, e.full_name as cashier_name,
              coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '—') as payment_methods
       from transactions t join employees e on e.id = t.cashier_id ${w} order by t.created_at desc limit ${limit} offset ${offset}`, params),
    db.query(`select count(*)::int as n, coalesce(sum(t.total), 0) as total, coalesce(sum(t.amount_paid - t.refunded_total), 0) as collected from transactions t ${w}`, params),
  ]);
  res.json({ rows: rows.rows, page, limit, count: total.rows[0].n, total: total.rows[0].total, collected: total.rows[0].collected });
});

transactionsRouter.get('/:id', can('transactions.view', 'pos.use'), async (req, res) => {
  const trx = await getTransaction(db, parse(zId, req.params.id));
  if (!has(req.user!, 'shifts.view_all') && !has(req.user!, 'reports.view') && trx.cashier_id !== req.user!.id) throw forbidden();
  res.json(trx);
});

transactionsRouter.post('/:id/payments', can('pos.use'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const input = parse(addPaymentSchema, req.body);
  res.status(201).json(await tx((q) => addPayment(q, req.user!, id, input, req.ip)));
});

transactionsRouter.post('/:id/refunds', can('refunds.request', 'refunds.approve'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const input = parse(refundSchema, req.body);
  res.status(201).json(await tx((q) => refund(q, req.user!, id, input, req.ip)));
});

transactionsRouter.post('/:id/reprint', can('transactions.view', 'pos.use'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const trx = await getTransaction(db, id);
  await audit(db, req, 'receipt.reprint', 'transaction', id, { transaction_no: trx.transaction_no });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cashier shifts
// ---------------------------------------------------------------------------
export const shiftsRouter = Router();

export async function shiftSummary(q: Q, shift: any) {
  const pay = await q.query(`select method, coalesce(sum(amount), 0) as amount, count(*)::int as count from payments where shift_id = $1 group by method order by method`, [shift.id]);
  const ref = await q.query(`select method, coalesce(sum(amount), 0) as amount, count(*)::int as count from refunds where shift_id = $1 group by method`, [shift.id]);
  const mv = await q.query(`select movement_type, coalesce(sum(amount), 0) as amount from cash_movements where shift_id = $1 group by movement_type`, [shift.id]);
  const trx = await one(q, `select count(*)::int as n, coalesce(sum(total), 0) as total from transactions where shift_id = $1`, [shift.id]);
  const of = (rows: any[], key: string, val: string) => D(rows.find((r) => r[key] === val)?.amount ?? 0);
  const cashSales = of(pay.rows, 'method', 'cash');
  const nonCash = pay.rows.filter((r) => r.method !== 'cash').reduce((a, r) => a.plus(r.amount), D(0));
  const cashRefunds = of(ref.rows, 'method', 'cash');
  const cashIn = of(mv.rows, 'movement_type', 'cash_in'), cashOut = of(mv.rows, 'movement_type', 'cash_out'), expenses = of(mv.rows, 'movement_type', 'expense');
  const expected = D(shift.opening_cash).plus(cashSales).minus(cashRefunds).plus(cashIn).minus(cashOut).minus(expenses);
  return {
    transactions: trx.n, sales_total: m(trx.total), opening_cash: m(shift.opening_cash), cash_sales: m(cashSales), non_cash_sales: m(nonCash),
    cash_refunds: m(cashRefunds), refunds_total: m(ref.rows.reduce((a, r) => a.plus(r.amount), D(0))), cash_in: m(cashIn), cash_out: m(cashOut), expenses: m(expenses),
    expected_cash: m(expected), by_method: pay.rows, refunds_by_method: ref.rows,
  };
}

async function shiftDetail(q: Q, id: string) {
  const shift = await one(q, `select s.*, e.full_name as cashier_name, c.full_name as closed_by_name from cashier_shifts s
                              join employees e on e.id = s.cashier_id left join employees c on c.id = s.closed_by where s.id = $1`, [id]);
  if (!shift) throw notFound('Shift');
  const movements = await q.query(`select cm.*, e.full_name as created_by_name from cash_movements cm join employees e on e.id = cm.created_by where cm.shift_id = $1 order by cm.created_at`, [id]);
  return { ...shift, summary: await shiftSummary(q, shift), movements: movements.rows };
}

shiftsRouter.get('/current', can('shifts.own'), async (req, res) => {
  const shift = await openShift(db, req.user!.id);
  res.json(shift ? await shiftDetail(db, shift.id) : null);
});

shiftsRouter.get('/', can('shifts.own', 'shifts.view_all'), async (req, res) => {
  const all = has(req.user!, 'shifts.view_all');
  const { rows } = await db.query(
    `select s.*, e.full_name as cashier_name,
            (select count(*)::int from transactions t where t.shift_id = s.id) as transactions,
            (select coalesce(sum(p.amount), 0) from payments p where p.shift_id = s.id) as collected
     from cashier_shifts s join employees e on e.id = s.cashier_id
     where ($1::uuid is null or s.cashier_id = $1) order by s.opened_at desc limit 300`, [all ? null : req.user!.id]);
  res.json(rows);
});

shiftsRouter.get('/:id', can('shifts.own', 'shifts.view_all'), async (req, res) => {
  const detail = await shiftDetail(db, parse(zId, req.params.id));
  if (!has(req.user!, 'shifts.view_all') && detail.cashier_id !== req.user!.id) throw forbidden();
  res.json(detail);
});

shiftsRouter.post('/open', can('shifts.own'), async (req, res) => {
  const { opening_cash } = parse(z.object({ opening_cash: zMoney }), req.body);
  const shift = await tx(async (q) => {
    if (await openShift(q, req.user!.id)) throw conflict('You already have an open shift');
    const s = await one(q, 'insert into cashier_shifts (shift_no, cashier_id, opening_cash) values ($1,$2,$3) returning *', [await numbers.shift(q), req.user!.id, opening_cash]);
    await audit(q, req, 'shift.open', 'shift', s.id, { shift_no: s.shift_no, opening_cash });
    return s;
  });
  res.status(201).json(await shiftDetail(db, shift.id));
});

shiftsRouter.post('/movements', can('shifts.own'), async (req, res) => {
  const d = parse(z.object({
    movement_type: z.enum(['cash_in', 'cash_out', 'expense']), amount: zMoney, reason: z.string().trim().min(3).max(500),
    category_id: zId.optional(), // required for expense
  }), req.body);
  if (!D(d.amount).gt(0)) throw badRequest('Amount must be greater than zero');
  await tx(async (q) => {
    const shift = await openShift(q, req.user!.id);
    if (!shift) throw conflict('You have no open shift', 'NO_SHIFT');
    let expenseId: string | null = null;
    if (d.movement_type === 'expense') {
      if (!d.category_id) throw badRequest('Choose an expense category');
      // Paid from the drawer now; still goes through expense approval for the books.
      expenseId = (await one(q, `insert into expenses (expense_no, category_id, description, amount, payment_method, shift_id, recorded_by)
                                 values ($1,$2,$3,$4,'cash',$5,$6) returning id`, [await numbers.expense(q), d.category_id, d.reason, d.amount, shift.id, req.user!.id])).id;
    }
    const mv = await one(q, 'insert into cash_movements (shift_id, movement_type, amount, reason, expense_id, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [shift.id, d.movement_type, d.amount, d.reason, expenseId, req.user!.id]);
    await audit(q, req, `shift.${d.movement_type}`, 'shift', shift.id, { shift_no: shift.shift_no, amount: d.amount, reason: d.reason, movement_id: mv.id });
  });
  res.status(201).json({ ok: true });
});

shiftsRouter.post('/:id/close', can('shifts.own', 'shifts.view_all'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z.object({ actual_cash: zMoney, notes: zOptText.optional() }), req.body);
  await tx(async (q) => {
    const shift = await one(q, 'select * from cashier_shifts where id = $1 for update', [id]);
    if (!shift) throw notFound('Shift');
    if (shift.status !== 'open') throw conflict('This shift is already closed');
    if (shift.cashier_id !== req.user!.id && !has(req.user!, 'shifts.view_all')) throw forbidden('Only the cashier or a supervisor can close this shift');
    const s = await shiftSummary(q, shift);
    const variance = D(d.actual_cash).minus(s.expected_cash);
    await q.query(`update cashier_shifts set status = 'closed', closed_at = now(), closed_by = $2, expected_cash = $3, actual_cash = $4, variance = $5, notes = $6 where id = $1`,
      [id, req.user!.id, s.expected_cash, d.actual_cash, m(variance), d.notes ?? null]);
    await audit(q, req, 'shift.close', 'shift', id, { shift_no: shift.shift_no, expected: s.expected_cash, actual: d.actual_cash, variance: m(variance) });
  });
  res.json(await shiftDetail(db, id));
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export const expensesRouter = Router();

expensesRouter.get('/', can('expenses.view'), async (req, res) => {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (str(req.query.from)) add('x.expense_date >= ?::date', parse(zDate, req.query.from));
  if (str(req.query.to)) add('x.expense_date <= ?::date', parse(zDate, req.query.to));
  if (str(req.query.status)) add('x.status = ?', req.query.status);
  if (str(req.query.category_id)) add('x.category_id = ?', parse(zId, req.query.category_id));
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const [rows, byCategory] = await Promise.all([
    db.query(`select x.*, c.name as category_name, r.full_name as recorded_by_name, a.full_name as approved_by_name
              from expenses x join expense_categories c on c.id = x.category_id join employees r on r.id = x.recorded_by
              left join employees a on a.id = x.approved_by ${w} order by x.expense_date desc, x.created_at desc limit 2000`, params),
    db.query(`select c.name as category, coalesce(sum(x.amount) filter (where x.status = 'approved'), 0) as approved,
                     coalesce(sum(x.amount) filter (where x.status = 'pending'), 0) as pending
              from expenses x join expense_categories c on c.id = x.category_id ${w} group by c.name order by approved desc`, params),
  ]);
  res.json({ rows: rows.rows, by_category: byCategory.rows });
});

const expenseSchema = z.object({
  expense_date: zDate, category_id: zId, description: z.string().trim().min(2).max(500), amount: zMoney,
  payment_method: z.enum(PAYMENT_METHODS).default('cash'), attachment_url: zOptText.optional(),
});

expensesRouter.post('/', can('expenses.create', 'expenses.approve'), async (req, res) => {
  const d = parse(expenseSchema, req.body);
  if (!D(d.amount).gt(0)) throw badRequest('Amount must be greater than zero');
  const row = await tx(async (q) => {
    const x = await one(q, `insert into expenses (expense_no, expense_date, category_id, description, amount, payment_method, attachment_url, recorded_by)
                            values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [await numbers.expense(q), d.expense_date, d.category_id, d.description, d.amount, d.payment_method, d.attachment_url ?? null, req.user!.id]);
    await audit(q, req, 'expense.create', 'expense', x.id, { expense_no: x.expense_no, amount: d.amount, description: d.description });
    return x;
  });
  res.status(201).json(row);
});

expensesRouter.put('/:id', can('expenses.create', 'expenses.approve'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(expenseSchema, req.body);
  const row = await tx(async (q) => {
    const x = await one(q, 'select * from expenses where id = $1 for update', [id]);
    if (!x) throw notFound('Expense');
    if (x.status !== 'pending') throw conflict('Only pending expenses can be edited');
    if (x.shift_id) throw conflict('This expense was paid from a cashier drawer and cannot be edited');
    if (x.recorded_by !== req.user!.id && !has(req.user!, 'expenses.approve')) throw forbidden();
    const after = await one(q, `update expenses set expense_date = $2, category_id = $3, description = $4, amount = $5, payment_method = $6, attachment_url = $7 where id = $1 returning *`,
      [id, d.expense_date, d.category_id, d.description, d.amount, d.payment_method, d.attachment_url ?? null]);
    await audit(q, req, 'expense.update', 'expense', id, { expense_no: x.expense_no, from: x.amount, to: d.amount });
    return after;
  });
  res.json(row);
});

expensesRouter.post('/:id/decision', can('expenses.approve'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['approved', 'rejected']) }), req.body);
  const row = await tx(async (q) => {
    const x = await one(q, 'select * from expenses where id = $1 for update', [id]);
    if (!x) throw notFound('Expense');
    if (x.status !== 'pending') throw conflict(`This expense is already ${x.status}`);
    const after = await one(q, 'update expenses set status = $2, approved_by = $3, approved_at = now() where id = $1 returning *', [id, status, req.user!.id]);
    await audit(q, req, `expense.${status}`, 'expense', id, { expense_no: x.expense_no, amount: x.amount });
    return after;
  });
  res.json(row);
});
