import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../shared/permissions';
import { audit, diff } from '../audit';
import { can, COOKIE, requireAuth, setSessionCookie, signSession, throttle, toAuthUser } from '../auth';
import { db, one, tx } from '../db';
import { badRequest, conflict, HttpError, notFound, parse, zId, zOptDate, zOptText, zText } from '../http';
import { numbers } from '../services/common';

export const authRouter = Router();

const passwordRule = z.string().min(8, 'Password must be at least 8 characters').max(100);

authRouter.post('/login', async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1) }), req.body);
  const gate = throttle(`login:${req.ip}:${email.toLowerCase()}`);
  const emp = await one(db, 'select * from employees where lower(email) = lower($1)', [email]);
  const ok = emp && emp.is_active && (await bcrypt.compare(password, emp.password_hash));
  if (!ok) {
    gate.fail();
    await audit(db, { user: null, ip: req.ip }, 'auth.login_failed', 'employee', emp?.id ?? null, { email });
    throw new HttpError(401, 'Incorrect email or password', 'BAD_CREDENTIALS');
  }
  gate.ok();
  await db.query('update employees set last_login_at = now() where id = $1', [emp.id]);
  setSessionCookie(res, signSession(emp));
  const user = toAuthUser(emp);
  await audit(db, { user, ip: req.ip }, 'auth.login', 'employee', emp.id);
  res.json({ user });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await audit(db, req, 'auth.logout', 'employee', req.user!.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = parse(z.object({ current_password: z.string().min(1), new_password: passwordRule }), req.body);
  const emp = await one(db, 'select * from employees where id = $1', [req.user!.id]);
  if (!(await bcrypt.compare(current_password, emp.password_hash))) throw badRequest('Current password is incorrect');
  // Bumping token_version signs out every other session of this account.
  const upd = await one(db, 'update employees set password_hash = $2, token_version = token_version + 1 where id = $1 returning *', [emp.id, await bcrypt.hash(new_password, 12)]);
  setSessionCookie(res, signSession(upd));
  await audit(db, req, 'auth.password_change', 'employee', emp.id);
  res.json({ ok: true });
});

// ---- Employee management (Super Admin) ------------------------------------
export const employeesRouter = Router();
const EMP_COLS = `id, employee_no, full_name, email, role, contact_number, position, hire_date, is_active, last_login_at, created_at`;

const employeeSchema = z.object({
  full_name: zText,
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES),
  contact_number: zOptText.optional(),
  position: zOptText.optional(),
  hire_date: zOptDate.optional(),
  is_active: z.boolean().optional(),
  password: passwordRule.optional().or(z.literal('').transform(() => undefined)),
});

// Any signed-in user may read the short staff list (used by filters); only employees.manage sees full details.
employeesRouter.get('/', async (req, res) => {
  const full = req.user!.permissions.includes('employees.manage');
  res.json((await db.query(`select ${full ? EMP_COLS : 'id, full_name, role, is_active'} from employees order by full_name`)).rows);
});

employeesRouter.post('/', can('employees.manage'), async (req, res) => {
  const d = parse(employeeSchema, req.body);
  if (!d.password) throw badRequest('A password is required for a new employee');
  const row = await tx(async (q) => {
    const created = await one(
      q,
      `insert into employees (employee_no, full_name, email, password_hash, role, contact_number, position, hire_date, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${EMP_COLS}`,
      [await numbers.employee(q), d.full_name, d.email, await bcrypt.hash(d.password!, 12), d.role, d.contact_number ?? null, d.position ?? null, d.hire_date ?? null, d.is_active ?? true],
    );
    await audit(q, req, 'employee.create', 'employee', created.id, { email: created.email, role: created.role });
    return created;
  });
  res.status(201).json(row);
});

employeesRouter.put('/:id', can('employees.manage'), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(employeeSchema.partial(), req.body);
  const row = await tx(async (q) => {
    const before = await one(q, 'select * from employees where id = $1 for update', [id]);
    if (!before) throw notFound('Employee');
    if (id === req.user!.id && (d.is_active === false || (d.role && d.role !== before.role))) {
      throw conflict('You cannot deactivate your own account or change your own role');
    }
    const losesSuper = before.role === 'super_admin' && ((d.role && d.role !== 'super_admin') || d.is_active === false);
    if (losesSuper) {
      const others = await one(q, `select count(*)::int as n from employees where role = 'super_admin' and is_active and id <> $1`, [id]);
      if (others.n === 0) throw conflict('At least one active Super Admin must remain');
    }
    const hash = d.password ? await bcrypt.hash(d.password, 12) : null;
    const after = await one(
      q,
      `update employees set full_name = coalesce($2, full_name), email = coalesce($3, email), role = coalesce($4, role),
          contact_number = case when $5::boolean then $6 else contact_number end, position = case when $7::boolean then $8 else position end,
          hire_date = case when $9::boolean then $10::date else hire_date end, is_active = coalesce($11, is_active),
          password_hash = coalesce($12, password_hash),
          token_version = token_version + case when $12::text is not null or $11::boolean is false or ($4::text is not null and $4::text <> role) then 1 else 0 end
       where id = $1 returning *`,
      [id, d.full_name ?? null, d.email ?? null, d.role ?? null, d.contact_number !== undefined, d.contact_number ?? null,
        d.position !== undefined, d.position ?? null, d.hire_date !== undefined, d.hire_date ?? null, d.is_active ?? null, hash],
    );
    await audit(q, req, 'employee.update', 'employee', id, { changes: diff(before, after, ['updated_at', 'password_hash', 'token_version']), password_reset: !!hash });
    return after;
  });
  const { password_hash, token_version, ...safe } = row;
  res.json(safe);
});
