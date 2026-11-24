// server/app.ts
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import fs from "node:fs";
import path2 from "node:path";

// server/auth.ts
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// shared/permissions.ts
var ROLES = ["super_admin", "admin", "manager", "cashier", "receptionist"];
var PERMISSIONS = [
  "dashboard.view",
  "dashboard.financials",
  "pos.use",
  "players.view",
  "players.manage",
  "courts.view",
  "courts.manage",
  "reservations.view",
  "reservations.manage",
  "memberships.view",
  "memberships.manage",
  "pricing.manage",
  "catalog.view",
  "inventory.manage",
  "services.manage",
  "rentals.manage",
  "discounts.manage",
  "discounts.approve",
  "transactions.view",
  "refunds.request",
  "refunds.approve",
  "shifts.own",
  "shifts.view_all",
  "expenses.view",
  "expenses.create",
  "expenses.approve",
  "reports.view",
  "employees.manage",
  "settings.manage",
  "audit.view"
];
var all = [...PERMISSIONS];
var without = (...p) => all.filter((x) => !p.includes(x));
var ROLE_PERMISSIONS = {
  super_admin: all,
  admin: without("employees.manage", "settings.manage", "pricing.manage"),
  manager: [
    "dashboard.view",
    "dashboard.financials",
    "players.view",
    "courts.view",
    "reservations.view",
    "memberships.view",
    "catalog.view",
    "transactions.view",
    "refunds.request",
    "refunds.approve",
    "discounts.approve",
    "shifts.view_all",
    "expenses.view",
    "expenses.approve",
    "reports.view",
    "audit.view"
  ],
  cashier: [
    "dashboard.view",
    "pos.use",
    "players.view",
    "players.manage",
    "courts.view",
    "reservations.view",
    "reservations.manage",
    "memberships.view",
    "catalog.view",
    "rentals.manage",
    "transactions.view",
    "refunds.request",
    "shifts.own",
    "expenses.create"
  ],
  receptionist: [
    "dashboard.view",
    "players.view",
    "players.manage",
    "courts.view",
    "reservations.view",
    "reservations.manage",
    "memberships.view",
    "catalog.view"
  ]
};
var roleCan = (role, permission) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
var PAYMENT_METHODS = ["cash", "gcash", "maya", "bank_transfer", "credit_card", "debit_card"];

// server/db.ts
import pg from "pg";

// server/env.ts
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
var rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: [path.join(rootDir, ".env.local"), path.join(rootDir, ".env")], quiet: true });
var isProd = process.env.NODE_ENV === "production";
var env = {
  isProd,
  port: Number(process.env.PORT ?? 4e3),
  // Pooled URL for the app; direct (unpooled) URL for migrations when available.
  databaseUrl: process.env.DATABASE_URL ?? "",
  databaseUrlDirect: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "",
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@ekourt.local",
  adminPassword: process.env.ADMIN_PASSWORD ?? ""
};
function assertEnv() {
  const missing = [];
  if (!env.databaseUrl) missing.push("DATABASE_URL (run `neon env pull` or set it in .env)");
  if (env.jwtSecret.length < 32) missing.push("JWT_SECRET (run `npm run setup` to generate one)");
  if (missing.length) {
    console.error("Missing configuration:\n  - " + missing.join("\n  - "));
    process.exit(1);
  }
}

// server/db.ts
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
var pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 3e4,
  connectionTimeoutMillis: 15e3
});
pool.on("error", (err) => console.error("[db] idle client error", err.message));
var db = {
  query: (sql, params) => pool.query(sql, params)
};
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({ query: (sql, params) => client.query(sql, params) });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
    });
    throw err;
  } finally {
    client.release();
  }
}
async function one(q, sql, params) {
  return (await q.query(sql, params)).rows[0];
}

// server/http.ts
import { Decimal } from "decimal.js";
import { z } from "zod";
var HttpError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var badRequest = (m2, code) => new HttpError(400, m2, code);
var notFound = (what = "Record") => new HttpError(404, `${what} not found`, "NOT_FOUND");
var conflict = (m2, code) => new HttpError(409, m2, code);
var forbidden = (m2 = "You do not have permission to do this", code = "FORBIDDEN") => new HttpError(403, m2, code);
function parse(schema2, data) {
  const r = schema2.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");
    throw new HttpError(400, msg, "VALIDATION");
  }
  return r.data;
}
var zId = z.string().uuid();
var zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
var zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
var blankToNull = (v) => v === "" || v === void 0 ? null : v;
var zText = z.string().trim().min(1).max(500);
var zOptText = z.preprocess(blankToNull, z.string().trim().max(2e3).nullable());
var zOptId = z.preprocess(blankToNull, zId.nullable());
var zOptDate = z.preprocess(blankToNull, zDate.nullable());
var zOptTime = z.preprocess(blankToNull, zTime.nullable());
var zMoney = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    const d = new Decimal(typeof v === "string" ? v.trim() : v);
    if (!d.isFinite() || d.isNegative() || d.gt("9999999999")) throw new Error();
    return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid amount" });
    return z.NEVER;
  }
});
var zInt = z.coerce.number().int();
var zBool = z.preprocess((v) => v === "true" ? true : v === "false" ? false : v, z.boolean());
var PG_ERRORS = {
  "23505": [409, "A record with the same unique value already exists"],
  "23503": [409, "This record is referenced by other records and cannot be removed"],
  "23P01": [409, "That court is already booked for the selected time"],
  "23514": [400, "A value is outside the allowed range"],
  "22P02": [400, "Invalid value"],
  "40001": [409, "The record changed while saving. Please try again"],
  "40P01": [409, "The record changed while saving. Please try again"]
};
function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err?.code === "P0001") return res.status(400).json({ error: err.message, code: "RULE" });
  if (err?.code && PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code];
    return res.status(status).json({ error: message, code: err.code, constraint: err.constraint });
  }
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
  if (err?.name === "MulterError") return res.status(400).json({ error: err.message });
  console.error("[api] unhandled error", err);
  res.status(500).json({ error: "Something went wrong on the server" });
}
function pageParams(query, maxLimit = 200) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), maxLimit);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;

// server/auth.ts
var COOKIE = "ek_session";
function signSession(emp) {
  return jwt.sign({ sub: emp.id, tv: emp.token_version }, env.jwtSecret, { expiresIn: `${env.sessionHours}h` });
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.isProd,
    maxAge: env.sessionHours * 3600 * 1e3,
    path: "/"
  });
}
function toAuthUser(e) {
  const role = e.role;
  return { id: e.id, employee_no: e.employee_no, full_name: e.full_name, email: e.email, role, permissions: ROLE_PERMISSIONS[role] ?? [] };
}
async function requireAuth(req, _res, next2) {
  const token = req.cookies?.[COOKIE];
  if (!token) throw new HttpError(401, "Please sign in", "UNAUTHENTICATED");
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new HttpError(401, "Your session has expired. Please sign in again", "UNAUTHENTICATED");
  }
  const emp = await one(db, "select * from employees where id = $1", [payload.sub]);
  if (!emp || !emp.is_active || emp.token_version !== payload.tv) {
    throw new HttpError(401, "Your session is no longer valid. Please sign in again", "UNAUTHENTICATED");
  }
  req.user = toAuthUser(emp);
  next2();
}
var can = (...perms) => (req, _res, next2) => {
  if (!req.user) throw new HttpError(401, "Please sign in", "UNAUTHENTICATED");
  if (!perms.some((p) => req.user.permissions.includes(p))) throw forbidden();
  next2();
};
var has = (user, perm) => user.permissions.includes(perm);
async function verifyApprover(q, creds, perm) {
  if (!creds?.email || !creds?.password) throw forbidden("Manager approval is required for this action", "APPROVAL_REQUIRED");
  const emp = await one(q, "select * from employees where lower(email) = lower($1) and is_active", [creds.email.trim()]);
  const ok = emp && await bcrypt.compare(creds.password, emp.password_hash);
  if (!ok) throw forbidden("Approver email or password is incorrect", "APPROVAL_INVALID");
  if (!roleCan(emp.role, perm)) throw forbidden(`${emp.full_name} is not authorised to approve this`, "APPROVAL_INVALID");
  return toAuthUser(emp);
}
var attempts = /* @__PURE__ */ new Map();
function throttle(key, max = 8, windowMs = 15 * 6e4) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.count >= max) {
    throw new HttpError(429, "Too many failed attempts. Please wait a few minutes and try again", "THROTTLED");
  }
  return {
    fail() {
      const cur = attempts.get(key);
      if (!cur || cur.until <= now) attempts.set(key, { count: 1, until: now + windowMs });
      else cur.count++;
    },
    ok() {
      attempts.delete(key);
    }
  };
}

// server/events.ts
var clients = /* @__PURE__ */ new Set();
function eventsHandler(req, res) {
  if (process.env.VERCEL) {
    res.status(204).end();
    return;
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}
function broadcast(topic) {
  const msg = `data: ${JSON.stringify({ topic, at: Date.now() })}

`;
  for (const c2 of clients) c2.write(msg);
}
function broadcastWrites(req, res, next2) {
  if (req.method !== "GET") {
    res.on("finish", () => {
      if (res.statusCode < 400) broadcast(req.path.split("/")[1] ?? "data");
    });
  }
  next2();
}

// server/routes/auth.ts
import bcrypt2 from "bcryptjs";
import { Router } from "express";
import { z as z2 } from "zod";

// server/audit.ts
async function audit(q, req, action, entity, entityId, details = {}) {
  await q.query(
    `insert into audit_logs (employee_id, employee_name, action, entity, entity_id, details, ip_address)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [req.user?.id ?? null, req.user?.full_name ?? null, action, entity ?? null, entityId ?? null, JSON.stringify(details), req.ip ?? null]
  );
}
function diff(before, after, ignore = ["updated_at", "created_at", "password_hash"]) {
  const changes = {};
  for (const k of Object.keys(after)) {
    if (ignore.includes(k)) continue;
    const a = before?.[k] instanceof Date ? before[k].toISOString() : before?.[k];
    const b = after[k] instanceof Date ? after[k].toISOString() : after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a, to: b };
  }
  return changes;
}

// server/services/common.ts
var pad = (n, len = 6) => String(n).padStart(len, "0");
async function next(q, name, year) {
  return Number((await one(q, "select next_number($1, $2) as n", [name, year])).n);
}
async function manilaYear(q) {
  return Number((await one(q, `select extract(year from now() at time zone 'Asia/Manila')::int as y`)).y);
}
var numbers = {
  player: async (q) => `EK-${pad(await next(q, "player", 0))}`,
  employee: async (q) => `EMP-${pad(await next(q, "employee", 0) + 1, 4)}`,
  reservation: async (q) => {
    const y = await manilaYear(q);
    return `EKB-${y}-${pad(await next(q, "reservation", y))}`;
  },
  transaction: async (q) => {
    const y = await manilaYear(q);
    return `EKT-${y}-${pad(await next(q, "transaction", y))}`;
  },
  refund: async (q) => {
    const y = await manilaYear(q);
    return `EKR-${y}-${pad(await next(q, "refund", y))}`;
  },
  membership: async (q) => {
    const y = await manilaYear(q);
    return `EKM-${y}-${pad(await next(q, "membership", y))}`;
  },
  rental: async (q) => {
    const y = await manilaYear(q);
    return `EKQ-${y}-${pad(await next(q, "rental", y))}`;
  },
  expense: async (q) => {
    const y = await manilaYear(q);
    return `EKX-${y}-${pad(await next(q, "expense", y))}`;
  },
  shift: async (q) => {
    const y = await manilaYear(q);
    return `EKS-${y}-${pad(await next(q, "shift", y))}`;
  }
};
var DEFAULTS = {
  business_name: "E-Kourt",
  business_address: "",
  business_contact: "",
  business_tin: "",
  receipt_footer: "",
  vat_registered: false,
  vat_rate: 12,
  sc_pwd_discount_rate: 20,
  sc_pwd_eligible_types: ["court", "service", "equipment"],
  member_discount_types: ["court"],
  require_open_shift: true,
  membership_expiry_notice_days: 7,
  booking_slot_minutes: 60,
  max_advance_booking_days: 30,
  duration_months: { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 }
};
async function getSettings(q) {
  const { rows } = await q.query("select key, value from business_settings");
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function activeMembership(q, playerId) {
  if (!playerId) return void 0;
  return one(
    q,
    `select pm.*, mp.name as plan_name, mp.code as plan_code, mp.court_discount_percent, mp.free_paddle_rentals_per_month,
            mp.priority_booking, mp.advance_booking_days
     from player_memberships pm join membership_plans mp on mp.id = pm.plan_id
     where pm.player_id = $1 and pm.status = 'active' and manila_today() between pm.start_date and pm.end_date
     limit 1`,
    [playerId]
  );
}
async function openShift(q, cashierId) {
  return one(q, `select * from cashier_shifts where cashier_id = $1 and status = 'open'`, [cashierId]);
}

// server/routes/auth.ts
var authRouter = Router();
var passwordRule = z2.string().min(8, "Password must be at least 8 characters").max(100);
authRouter.post("/login", async (req, res) => {
  const { email, password } = parse(z2.object({ email: z2.string().trim().email(), password: z2.string().min(1) }), req.body);
  const gate = throttle(`login:${req.ip}:${email.toLowerCase()}`);
  const emp = await one(db, "select * from employees where lower(email) = lower($1)", [email]);
  const ok = emp && emp.is_active && await bcrypt2.compare(password, emp.password_hash);
  if (!ok) {
    gate.fail();
    await audit(db, { user: null, ip: req.ip }, "auth.login_failed", "employee", emp?.id ?? null, { email });
    throw new HttpError(401, "Incorrect email or password", "BAD_CREDENTIALS");
  }
  gate.ok();
  await db.query("update employees set last_login_at = now() where id = $1", [emp.id]);
  setSessionCookie(res, signSession(emp));
  const user = toAuthUser(emp);
  await audit(db, { user, ip: req.ip }, "auth.login", "employee", emp.id);
  res.json({ user });
});
authRouter.post("/logout", requireAuth, async (req, res) => {
  await audit(db, req, "auth.logout", "employee", req.user.id);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});
authRouter.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = parse(z2.object({ current_password: z2.string().min(1), new_password: passwordRule }), req.body);
  const emp = await one(db, "select * from employees where id = $1", [req.user.id]);
  if (!await bcrypt2.compare(current_password, emp.password_hash)) throw badRequest("Current password is incorrect");
  const upd = await one(db, "update employees set password_hash = $2, token_version = token_version + 1 where id = $1 returning *", [emp.id, await bcrypt2.hash(new_password, 12)]);
  setSessionCookie(res, signSession(upd));
  await audit(db, req, "auth.password_change", "employee", emp.id);
  res.json({ ok: true });
});
var employeesRouter = Router();
var EMP_COLS = `id, employee_no, full_name, email, role, contact_number, position, hire_date, is_active, last_login_at, created_at`;
var employeeSchema = z2.object({
  full_name: zText,
  email: z2.string().trim().toLowerCase().email(),
  role: z2.enum(ROLES),
  contact_number: zOptText.optional(),
  position: zOptText.optional(),
  hire_date: zOptDate.optional(),
  is_active: z2.boolean().optional(),
  password: passwordRule.optional().or(z2.literal("").transform(() => void 0))
});
employeesRouter.get("/", async (req, res) => {
  const full = req.user.permissions.includes("employees.manage");
  res.json((await db.query(`select ${full ? EMP_COLS : "id, full_name, role, is_active"} from employees order by full_name`)).rows);
});
employeesRouter.post("/", can("employees.manage"), async (req, res) => {
  const d = parse(employeeSchema, req.body);
  if (!d.password) throw badRequest("A password is required for a new employee");
  const row = await tx(async (q) => {
    const created = await one(
      q,
      `insert into employees (employee_no, full_name, email, password_hash, role, contact_number, position, hire_date, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${EMP_COLS}`,
      [await numbers.employee(q), d.full_name, d.email, await bcrypt2.hash(d.password, 12), d.role, d.contact_number ?? null, d.position ?? null, d.hire_date ?? null, d.is_active ?? true]
    );
    await audit(q, req, "employee.create", "employee", created.id, { email: created.email, role: created.role });
    return created;
  });
  res.status(201).json(row);
});
employeesRouter.put("/:id", can("employees.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(employeeSchema.partial(), req.body);
  const row = await tx(async (q) => {
    const before = await one(q, "select * from employees where id = $1 for update", [id]);
    if (!before) throw notFound("Employee");
    if (id === req.user.id && (d.is_active === false || d.role && d.role !== before.role)) {
      throw conflict("You cannot deactivate your own account or change your own role");
    }
    const losesSuper = before.role === "super_admin" && (d.role && d.role !== "super_admin" || d.is_active === false);
    if (losesSuper) {
      const others = await one(q, `select count(*)::int as n from employees where role = 'super_admin' and is_active and id <> $1`, [id]);
      if (others.n === 0) throw conflict("At least one active Super Admin must remain");
    }
    const hash = d.password ? await bcrypt2.hash(d.password, 12) : null;
    const after = await one(
      q,
      `update employees set full_name = coalesce($2, full_name), email = coalesce($3, email), role = coalesce($4, role),
          contact_number = case when $5::boolean then $6 else contact_number end, position = case when $7::boolean then $8 else position end,
          hire_date = case when $9::boolean then $10::date else hire_date end, is_active = coalesce($11, is_active),
          password_hash = coalesce($12, password_hash),
          token_version = token_version + case when $12::text is not null or $11::boolean is false or ($4::text is not null and $4::text <> role) then 1 else 0 end
       where id = $1 returning *`,
      [
        id,
        d.full_name ?? null,
        d.email ?? null,
        d.role ?? null,
        d.contact_number !== void 0,
        d.contact_number ?? null,
        d.position !== void 0,
        d.position ?? null,
        d.hire_date !== void 0,
        d.hire_date ?? null,
        d.is_active ?? null,
        hash
      ]
    );
    await audit(q, req, "employee.update", "employee", id, { changes: diff(before, after, ["updated_at", "password_hash", "token_version"]), password_reset: !!hash });
    return after;
  });
  const { password_hash, token_version, ...safe } = row;
  res.json(safe);
});

// server/routes/catalog.ts
import { Router as Router3 } from "express";
import { z as z3 } from "zod";

// server/crud.ts
import { Router as Router2 } from "express";
function crud(o) {
  const r = Router2();
  const cols = Object.keys(o.schema.shape);
  r.get("/", can(...o.view), async (req, res) => {
    const params = [];
    const where = [];
    const q = str(req.query.q);
    if (q && o.search?.length) {
      params.push(`%${q.toLowerCase()}%`);
      where.push("(" + o.search.map((c2) => `lower(t.${c2}::text) like $1`).join(" or ") + ")");
    }
    const sql = `select ${o.select ?? "t.*"} from ${o.table} t ${o.joins ?? ""} ${where.length ? "where " + where.join(" and ") : ""} order by ${o.orderBy ?? "t.created_at"}`;
    res.json((await db.query(sql, params)).rows);
  });
  r.post("/", can(...o.manage), async (req, res) => {
    const data = parse(o.schema, req.body);
    const keys = cols.filter((c2) => data[c2] !== void 0);
    const row = await tx(async (q) => {
      const created = await one(
        q,
        `insert into ${o.table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
        keys.map((k) => data[k])
      );
      await o.afterCreate?.(q, created);
      await audit(q, req, `${o.entity}.create`, o.entity, created.id, { record: created });
      return created;
    });
    res.status(201).json(row);
  });
  r.put("/:id", can(...o.manage), async (req, res) => {
    const id = parse(zId, req.params.id);
    const data = parse(o.schema.partial(), req.body);
    const keys = cols.filter((c2) => data[c2] !== void 0);
    const row = await tx(async (q) => {
      const before = await one(q, `select * from ${o.table} where id = $1 for update`, [id]);
      if (!before) throw notFound();
      if (!keys.length) return before;
      const after = await one(
        q,
        `update ${o.table} set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning *`,
        [id, ...keys.map((k) => data[k])]
      );
      const changes = diff(before, after);
      if (Object.keys(changes).length) await audit(q, req, `${o.entity}.update`, o.entity, id, { changes });
      return after;
    });
    res.json(row);
  });
  if (!o.noDelete) {
    r.delete("/:id", can(...o.manage), async (req, res) => {
      const id = parse(zId, req.params.id);
      await tx(async (q) => {
        const before = await one(q, `select * from ${o.table} where id = $1`, [id]);
        if (!before) throw notFound();
        if (o.softDelete) {
          await q.query(`update ${o.table} set ${o.softDelete.column} = $2 where id = $1`, [id, o.softDelete.value]);
          await audit(q, req, `${o.entity}.archive`, o.entity, id, { name: before.name ?? before.code });
        } else {
          await q.query(`delete from ${o.table} where id = $1`, [id]);
          await audit(q, req, `${o.entity}.delete`, o.entity, id, { record: before });
        }
      });
      res.json({ ok: true });
    });
  }
  return r;
}

// server/routes/catalog.ts
var nonNeg = z3.coerce.number().int().min(0);
var VIEW = ["catalog.view"];
var productsRouter = crud({
  table: "products",
  entity: "product",
  view: [...VIEW],
  manage: ["inventory.manage"],
  orderBy: "t.name",
  search: ["name", "code"],
  select: `t.*, c.name as category_name, s.name as supplier_name, (t.stock_qty <= t.min_stock) as low_stock`,
  joins: "left join product_categories c on c.id = t.category_id left join suppliers s on s.id = t.supplier_id",
  // stock_qty is deliberately absent: stock only changes through inventory movements.
  schema: z3.object({
    code: zText,
    name: zText,
    category_id: zOptId.optional(),
    description: zOptText.optional(),
    cost_price: zMoney,
    selling_price: zMoney,
    min_stock: nonNeg.default(0),
    supplier_id: zOptId.optional(),
    image_url: zOptText.optional(),
    status: z3.enum(["active", "archived"]).default("active")
  }),
  softDelete: { column: "status", value: "archived" }
});
var categoriesRouter = crud({
  table: "product_categories",
  entity: "product_category",
  view: [...VIEW],
  manage: ["inventory.manage"],
  orderBy: "t.name",
  search: ["name"],
  schema: z3.object({ name: zText, description: zOptText.optional(), is_active: zBool.default(true) })
});
var suppliersRouter = crud({
  table: "suppliers",
  entity: "supplier",
  view: [...VIEW],
  manage: ["inventory.manage"],
  orderBy: "t.name",
  search: ["name", "contact_person"],
  schema: z3.object({ name: zText, contact_person: zOptText.optional(), contact_number: zOptText.optional(), email: zOptText.optional(), address: zOptText.optional(), is_active: zBool.default(true) })
});
var servicesRouter = crud({
  table: "services",
  entity: "service",
  view: [...VIEW],
  manage: ["services.manage"],
  orderBy: "t.category, t.name",
  search: ["name", "code", "category"],
  schema: z3.object({
    code: zText,
    name: zText,
    description: zOptText.optional(),
    category: zText.default("general"),
    charge_method: z3.enum(["per_hour", "per_person", "per_session", "per_item", "fixed"]).default("fixed"),
    price: zMoney,
    is_active: zBool.default(true)
  }),
  softDelete: { column: "is_active", value: false }
});
var ratesRouter = crud({
  table: "court_rates",
  entity: "court_rate",
  view: [...VIEW],
  manage: ["pricing.manage"],
  orderBy: "t.rate_type, t.duration_hours",
  search: ["name", "rate_type"],
  schema: z3.object({
    name: zText,
    rate_type: z3.enum(["weekday", "weekend", "holiday", "peak", "off_peak", "promo"]),
    duration_hours: z3.coerce.number().positive().max(24),
    price: zMoney,
    day_scope: z3.enum(["all", "weekday", "weekend"]).default("all"),
    start_time: zOptTime.optional(),
    end_time: zOptTime.optional(),
    valid_from: zOptDate.optional(),
    valid_to: zOptDate.optional(),
    is_active: zBool.default(true)
  })
});
var holidaysRouter = crud({
  table: "holidays",
  entity: "holiday",
  view: [...VIEW],
  manage: ["pricing.manage"],
  orderBy: "t.holiday_date",
  schema: z3.object({ holiday_date: zDate, name: zText })
});
var discountsRouter = crud({
  table: "discounts",
  entity: "discount",
  view: [...VIEW],
  manage: ["discounts.manage"],
  orderBy: "t.name",
  search: ["name", "code"],
  schema: z3.object({
    code: z3.preprocess((v) => v === "" || v == null ? null : String(v).trim().toUpperCase(), z3.string().max(40).nullable()).optional(),
    name: zText,
    discount_type: z3.enum(["percentage", "fixed", "promo", "senior", "pwd", "special_event"]),
    value_type: z3.enum(["percent", "fixed"]).default("percent"),
    value: zMoney,
    applies_to: z3.array(z3.enum(["court", "product", "service", "equipment", "membership", "charge"])).default([]),
    min_amount: zMoney.default("0.00"),
    valid_from: zOptDate.optional(),
    valid_to: zOptDate.optional(),
    usage_limit: z3.preprocess((v) => v === "" || v == null ? null : v, z3.coerce.number().int().min(1).nullable()).optional(),
    requires_approval: zBool.default(false),
    stackable_with_membership: zBool.default(false),
    is_active: zBool.default(true)
  }),
  softDelete: { column: "is_active", value: false }
});
var expenseCategoriesRouter = crud({
  table: "expense_categories",
  entity: "expense_category",
  view: ["expenses.view", "expenses.create"],
  manage: ["expenses.approve"],
  orderBy: "t.name",
  schema: z3.object({ name: zText, is_active: zBool.default(true) })
});
var plansRouter = Router3();
var planSchema = z3.object({
  code: zText,
  name: zText,
  description: zOptText.optional(),
  monthly_price: zMoney,
  court_discount_percent: z3.coerce.number().min(0).max(100),
  free_paddle_rentals_per_month: nonNeg.default(0),
  priority_booking: zBool.default(false),
  advance_booking_days: nonNeg.default(7),
  sort_order: z3.coerce.number().int().default(0),
  is_active: zBool.default(true)
});
var benefitsSchema = z3.object({ benefits: z3.array(zText).max(30) });
plansRouter.get("/", can("catalog.view", "memberships.view"), async (_req, res) => {
  const { rows } = await db.query(`
    select p.*, coalesce((select json_agg(b.description order by b.sort_order) from membership_benefits b where b.plan_id = p.id), '[]') as benefits,
           (select count(*)::int from player_memberships pm where pm.plan_id = p.id and pm.status = 'active' and pm.end_date >= manila_today()) as active_members
    from membership_plans p order by p.sort_order, p.monthly_price`);
  res.json(rows);
});
plansRouter.put("/:id/benefits", can("pricing.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { benefits } = parse(benefitsSchema, req.body);
  await tx(async (q) => {
    await q.query("delete from membership_benefits where plan_id = $1", [id]);
    for (const [i, b] of benefits.entries()) await q.query("insert into membership_benefits (plan_id, description, sort_order) values ($1,$2,$3)", [id, b, i + 1]);
    await audit(q, req, "membership_plan.benefits_update", "membership_plan", id, { benefits });
  });
  res.json({ ok: true });
});
plansRouter.use("/", crud({ table: "membership_plans", entity: "membership_plan", view: ["catalog.view"], manage: ["pricing.manage"], schema: planSchema, softDelete: { column: "is_active", value: false } }));
var equipmentRouter = Router3();
var equipmentSchema = z3.object({
  code: zText,
  name: zText,
  description: zOptText.optional(),
  rental_rate: zMoney,
  charge_method: z3.enum(["per_hour", "per_session", "per_use"]).default("per_session"),
  entitlement_type: z3.preprocess((v) => v === "" || v == null ? null : v, z3.enum(["free_paddle_rental"]).nullable()).optional(),
  is_active: zBool.default(true)
});
equipmentRouter.post("/:id/adjust", can("inventory.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z3.object({ total_qty: nonNeg, damaged_qty: nonNeg, missing_qty: nonNeg, notes: zOptText.optional() }), req.body);
  const row = await tx(async (q) => {
    const e = await one(q, "select * from equipment where id = $1 for update", [id]);
    if (!e) throw notFound("Equipment");
    const out = (await one(q, `select coalesce(sum(quantity - qty_returned - qty_damaged - qty_missing), 0)::int as n from equipment_rentals where equipment_id = $1 and status = 'rented'`, [id])).n;
    const available = d.total_qty - d.damaged_qty - d.missing_qty - out;
    if (available < 0) throw badRequest(`${out} unit(s) are currently rented out, so total must be at least ${out + d.damaged_qty + d.missing_qty}`);
    const after = await one(q, "update equipment set total_qty = $2, damaged_qty = $3, missing_qty = $4, available_qty = $5 where id = $1 returning *", [id, d.total_qty, d.damaged_qty, d.missing_qty, available]);
    await audit(q, req, "equipment.adjust", "equipment", id, { before: { total: e.total_qty, available: e.available_qty, damaged: e.damaged_qty, missing: e.missing_qty }, after: { ...d, available } });
    return after;
  });
  res.json(row);
});
equipmentRouter.use("/", crud({
  table: "equipment",
  entity: "equipment",
  view: [...VIEW],
  manage: ["inventory.manage"],
  orderBy: "t.name",
  search: ["name", "code"],
  schema: equipmentSchema,
  select: `t.*, (t.total_qty - t.available_qty - t.damaged_qty - t.missing_qty) as rented_qty`,
  softDelete: { column: "is_active", value: false }
}));
var rentalsRouter = Router3();
rentalsRouter.get("/", can("catalog.view"), async (req, res) => {
  const status = str(req.query.status);
  const { rows } = await db.query(
    `select er.*, e.name as equipment_name, e.code as equipment_code, p.player_no, t.transaction_no, ie.full_name as issued_by_name,
            (er.status = 'rented' and er.expected_return_at is not null and er.expected_return_at < now()) as overdue
     from equipment_rentals er join equipment e on e.id = er.equipment_id
     left join players p on p.id = er.player_id left join transactions t on t.id = er.transaction_id left join employees ie on ie.id = er.issued_by
     where ($1::text is null or er.status = $1) order by er.rented_at desc limit 500`,
    [status ?? null]
  );
  res.json(rows);
});
rentalsRouter.post("/:id/return", can("rentals.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z3.object({ qty_damaged: nonNeg.default(0), qty_missing: nonNeg.default(0), notes: zOptText.optional() }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, "select * from equipment_rentals where id = $1 for update", [id]);
    if (!r) throw notFound("Rental");
    if (r.status !== "rented") throw conflict("This rental has already been returned");
    if (d.qty_damaged + d.qty_missing > r.quantity) throw badRequest("Damaged and missing units exceed the rented quantity");
    const good = r.quantity - d.qty_damaged - d.qty_missing;
    await q.query("update equipment set available_qty = available_qty + $2, damaged_qty = damaged_qty + $3, missing_qty = missing_qty + $4 where id = $1", [r.equipment_id, good, d.qty_damaged, d.qty_missing]);
    const after = await one(
      q,
      `update equipment_rentals set status = $2, returned_at = now(), qty_returned = $3, qty_damaged = $4, qty_missing = $5, received_by = $6, notes = coalesce($7, notes)
       where id = $1 returning *`,
      [id, d.qty_damaged + d.qty_missing > 0 ? "returned_with_issues" : "returned", good, d.qty_damaged, d.qty_missing, req.user.id, d.notes ?? null]
    );
    await audit(q, req, "rental.return", "equipment_rental", id, { rental_no: r.rental_no, good, damaged: d.qty_damaged, missing: d.qty_missing });
    return after;
  });
  res.json(row);
});
var inventoryRouter = Router3();
inventoryRouter.get("/movements", can("catalog.view"), async (req, res) => {
  const productId = str(req.query.product_id);
  const { rows } = await db.query(
    `select im.*, p.name as product_name, p.code as product_code, e.full_name as created_by_name, t.transaction_no
     from inventory_movements im join products p on p.id = im.product_id
     left join employees e on e.id = im.created_by left join transactions t on t.id = im.transaction_id
     where ($1::uuid is null or im.product_id = $1) order by im.created_at desc limit 500`,
    [productId ?? null]
  );
  res.json(rows);
});
inventoryRouter.post("/movements", can("inventory.manage"), async (req, res) => {
  const d = parse(z3.object({
    product_id: zId,
    movement_type: z3.enum(["stock_in", "stock_out", "adjustment"]),
    quantity: z3.coerce.number().int().min(0).max(1e6),
    // adjustment: the new counted quantity
    unit_cost: zMoney.optional(),
    notes: zOptText.optional()
  }), req.body);
  if (d.movement_type !== "adjustment" && d.quantity === 0) throw badRequest("Quantity must be greater than zero");
  if (d.movement_type !== "stock_in" && !d.notes) throw badRequest("A reason is required for stock-out and adjustments");
  const row = await tx(async (q) => {
    const p = await one(q, "select * from products where id = $1 for update", [d.product_id]);
    if (!p) throw notFound("Product");
    const delta = d.movement_type === "stock_in" ? d.quantity : d.movement_type === "stock_out" ? -d.quantity : d.quantity - p.stock_qty;
    const balance = p.stock_qty + delta;
    if (balance < 0) throw conflict(`Only ${p.stock_qty} in stock`);
    await q.query("update products set stock_qty = $2, cost_price = coalesce($3::numeric, cost_price) where id = $1", [p.id, balance, d.movement_type === "stock_in" ? d.unit_cost ?? null : null]);
    const mv = await one(
      q,
      `insert into inventory_movements (product_id, movement_type, quantity, balance_after, unit_cost, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [p.id, d.movement_type, delta, balance, d.unit_cost ?? p.cost_price, d.notes ?? null, req.user.id]
    );
    await audit(q, req, `inventory.${d.movement_type}`, "product", p.id, { product: p.name, from: p.stock_qty, to: balance, delta, notes: d.notes });
    return mv;
  });
  res.status(201).json(row);
});
var membershipsRouter = Router3();
membershipsRouter.get("/", can("memberships.view"), async (req, res) => {
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
    [status ?? null, str(req.query.player_id) ?? null, Number(req.query.days ?? 7)]
  );
  res.json(rows);
});
membershipsRouter.post("/:id/status", can("memberships.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z3.object({ action: z3.enum(["suspend", "resume", "cancel"]), reason: z3.string().trim().min(3).max(500) }), req.body);
  const row = await tx(async (q) => {
    const mem = await one(q, "select * from player_memberships where id = $1 for update", [id]);
    if (!mem) throw notFound("Membership");
    const allowed = { suspend: ["active"], resume: ["suspended"], cancel: ["active", "suspended"] }[d.action];
    if (!allowed.includes(mem.status)) throw conflict(`A ${mem.status} membership cannot be ${d.action === "resume" ? "resumed" : d.action + "ed"}`);
    const status = { suspend: "suspended", resume: "active", cancel: "cancelled" }[d.action];
    const after = await one(q, "update player_memberships set status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 where id = $1 returning *", [id, status, d.reason, req.user.id]);
    await audit(q, req, `membership.${d.action}`, "membership", id, { membership_no: mem.membership_no, reason: d.reason });
    return after;
  });
  res.json(row);
});

// server/routes/players.ts
import { Router as Router4 } from "express";
import { z as z5 } from "zod";

// server/services/reservations.ts
import { z as z4 } from "zod";

// server/money.ts
import { Decimal as Decimal2 } from "decimal.js";
Decimal2.set({ precision: 30, rounding: Decimal2.ROUND_HALF_UP });
var D = (v) => new Decimal2(v ?? 0);
var ZERO = new Decimal2(0);
var r2 = (d) => d.toDecimalPlaces(2, Decimal2.ROUND_HALF_UP);
var m = (d) => new Decimal2(d).toDecimalPlaces(2, Decimal2.ROUND_HALF_UP).toFixed(2);
var sum = (values) => values.reduce((a, b) => a.plus(b), ZERO);
var minD = (a, b) => a.lt(b) ? a : b;

// server/services/pricing.ts
function packagePrice(rates, hours) {
  const units = Math.round(hours * 2);
  const packs = rates.map((r) => ({ u: Math.round(Number(r.duration_hours) * 2), p: D(r.price) })).filter((p) => p.u > 0);
  if (!packs.length) return null;
  const best = [ZERO];
  for (let u = 1; u <= units; u++) {
    let min = null;
    for (const p of packs) {
      const prev = p.u <= u ? best[u - p.u] : null;
      if (prev) {
        const c2 = prev.plus(p.p);
        if (!min || c2.lt(min)) min = c2;
      }
    }
    best[u] = min;
  }
  if (best[units]) return best[units];
  const shortest = packs.reduce((a, b) => a.u <= b.u ? a : b);
  return r2(shortest.p.div(shortest.u).times(units));
}
var inWindow = (r, start) => (!r.start_time || r.start_time.slice(0, 5) <= start) && (!r.end_time || start < r.end_time.slice(0, 5));
async function quoteCourt(q, input) {
  const court = await one(q, "select * from courts where id = $1", [input.court_id]);
  if (!court) throw notFound("Court");
  if (!(input.duration_hours > 0) || Math.round(input.duration_hours * 2) !== input.duration_hours * 2) {
    throw badRequest("Duration must be in half-hour steps");
  }
  const info = await one(
    q,
    `select extract(dow from $1::date)::int as dow,
            exists(select 1 from holidays where holiday_date = $1::date) as is_holiday,
            to_char($1::date + $2::time + ($3 || ' minutes')::interval, 'HH24:MI') as end_time`,
    [input.date, input.start_time, Math.round(input.duration_hours * 60)]
  );
  const dayType = info.dow === 0 || info.dow === 6 ? "weekend" : "weekday";
  const { rows: rates } = await q.query(
    `select * from court_rates
     where is_active and (valid_from is null or valid_from <= $1::date) and (valid_to is null or valid_to >= $1::date)
       and (day_scope = 'all' or day_scope = $2)`,
    [input.date, dayType]
  );
  const of = (type, windowed = false) => rates.filter((r) => r.rate_type === type && (!windowed || inWindow(r, input.start_time)));
  const candidates = [
    ["promo", of("promo", true)],
    ...info.is_holiday ? [["holiday", of("holiday")]] : [],
    ["peak", of("peak", true).filter((r) => r.start_time || r.end_time)],
    ["off_peak", of("off_peak", true).filter((r) => r.start_time || r.end_time)],
    [dayType, of(dayType)]
  ];
  let rateType = "court_hourly";
  let amount = null;
  for (const [type, list] of candidates) {
    const price = packagePrice(list, input.duration_hours);
    if (price) {
      rateType = type;
      amount = price;
      break;
    }
  }
  if (!amount) amount = r2(D(court.hourly_rate).times(input.duration_hours));
  const settings = await getSettings(q);
  const membership = await activeMembership(q, input.player_id) ?? null;
  const percent = membership && settings.member_discount_types.includes("court") ? D(membership.court_discount_percent) : ZERO;
  const discount = r2(amount.times(percent).div(100));
  return {
    court,
    rate_type: rateType,
    rate_amount: m(amount),
    discount_percent: percent.toFixed(2),
    discount_amount: m(discount),
    total: m(amount.minus(discount)),
    membership,
    end_time: info.end_time
  };
}

// server/services/reservations.ts
var LIVE_STATUSES = ["pending", "confirmed", "checked_in", "in_progress"];
var bookingSchema = z4.object({
  court_id: zId,
  date: zDate,
  start_time: zTime,
  duration_hours: z4.coerce.number().positive().max(24),
  player_id: zOptId.optional(),
  customer_name: zOptText.optional(),
  customer_contact: zOptText.optional(),
  notes: zOptText.optional(),
  is_walk_in: z4.boolean().optional(),
  extra_player_ids: z4.array(zId).max(20).optional()
});
var RESERVATION_SELECT = `
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
var toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
async function validateSlot(q, input, opts = {}) {
  const court = await one(q, "select * from courts where id = $1 for update", [input.court_id]);
  if (!court) throw notFound("Court");
  if (!court.is_active || court.status === "closed") throw conflict(`${court.name} is closed`);
  if (court.status === "maintenance") throw conflict(`${court.name} is under maintenance`);
  const slot = await one(
    q,
    `select extract(dow from $1::date)::int as dow, manila_today()::text as today,
            ($1::date - manila_today()) as days_ahead,
            (($1::date + $2::time) at time zone 'Asia/Manila') as start_at,
            (($1::date + $2::time + ($3 || ' minutes')::interval) at time zone 'Asia/Manila') as end_at,
            (($1::date + $2::time + ($3 || ' minutes')::interval) at time zone 'Asia/Manila') <= now() as is_past`,
    [input.date, input.start_time, Math.round(input.duration_hours * 60)]
  );
  if (slot.days_ahead < 0 || slot.is_past) throw badRequest("That time slot has already passed");
  if (opts.advanceDays !== void 0 && slot.days_ahead > opts.advanceDays) {
    throw badRequest(`Bookings can be made at most ${opts.advanceDays} days in advance for this customer`);
  }
  const hours = await one(q, "select * from court_operating_hours where court_id = $1 and day_of_week = $2", [input.court_id, slot.dow]);
  if (hours?.is_closed) throw conflict(`${court.name} is closed on that day`);
  const open = toMin(hours?.open_time ?? "00:00");
  const close = toMin(hours?.close_time ?? "23:59");
  const start = toMin(input.start_time);
  const end = start + Math.round(input.duration_hours * 60);
  if (start < open || end > close) {
    throw badRequest(`${court.name} is open ${String(hours?.open_time ?? "00:00").slice(0, 5)}\u2013${String(hours?.close_time ?? "24:00").slice(0, 5)} on that day`);
  }
  const clash = await one(
    q,
    `select reference_no from reservations
     where court_id = $1 and status = any($2::text[]) and tstzrange(start_at, end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
       and ($5::uuid is null or id <> $5) limit 1`,
    [input.court_id, LIVE_STATUSES, slot.start_at, slot.end_at, opts.excludeId ?? null]
  );
  if (clash) throw conflict(`${court.name} is already booked for that time (${clash.reference_no})`, "SLOT_TAKEN");
  return { court, start_at: slot.start_at, end_at: slot.end_at };
}
async function createReservation(q, user, input, ip) {
  let customerName = input.customer_name ?? null;
  let contact = input.customer_contact ?? null;
  if (input.player_id) {
    const player = await one(q, "select * from players where id = $1", [input.player_id]);
    if (!player) throw notFound("Player");
    if (player.status === "banned") throw conflict(`${player.full_name} is banned and cannot book`);
    customerName = player.full_name;
    contact = contact ?? player.contact_number;
  }
  if (!customerName) customerName = "Walk-in Customer";
  const quote = await quoteCourt(q, input);
  const settings = await getSettings(q);
  const advanceDays = Math.max(settings.max_advance_booking_days, quote.membership?.advance_booking_days ?? 0);
  const slot = await validateSlot(q, input, { advanceDays });
  const row = await one(
    q,
    `insert into reservations (reference_no, player_id, customer_name, customer_contact, court_id, start_at, end_at, duration_hours,
        status, is_walk_in, rate_type, rate_amount, discount_amount, total_amount, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15,$15) returning *`,
    [
      await numbers.reservation(q),
      input.player_id ?? null,
      customerName,
      contact,
      input.court_id,
      slot.start_at,
      slot.end_at,
      input.duration_hours,
      input.is_walk_in ?? false,
      quote.rate_type,
      quote.rate_amount,
      quote.discount_amount,
      quote.total,
      input.notes ?? null,
      user.id
    ]
  );
  for (const pid of new Set(input.extra_player_ids ?? [])) {
    if (pid !== input.player_id) await q.query("insert into reservation_players (reservation_id, player_id) values ($1, $2)", [row.id, pid]);
  }
  await audit(q, { user, ip }, "reservation.create", "reservation", row.id, {
    reference_no: row.reference_no,
    court: slot.court.name,
    date: input.date,
    start_time: input.start_time,
    duration_hours: input.duration_hours,
    total: quote.total
  });
  return { reservation: row, quote };
}
async function getReservation(q, id) {
  const row = await one(q, `${RESERVATION_SELECT} where r.id = $1`, [id]);
  if (!row) throw notFound("Reservation");
  return row;
}

// server/routes/players.ts
var playersRouter = Router4();
var schema = z5.object({
  full_name: zText,
  gender: z5.preprocess((v) => v === "" ? null : v, z5.enum(["male", "female", "other"]).nullable()).optional(),
  birthday: zOptDate.optional(),
  contact_number: zOptText.optional(),
  email: z5.preprocess((v) => v === "" || v == null ? null : String(v).trim().toLowerCase(), z5.string().email().nullable()).optional(),
  address: zOptText.optional(),
  emergency_contact_name: zOptText.optional(),
  emergency_contact_number: zOptText.optional(),
  status: z5.enum(["active", "inactive", "banned"]).optional(),
  photo_url: zOptText.optional(),
  notes: zOptText.optional()
});
var PLAYER_SELECT = `
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
async function assertNoDuplicate(q, d, excludeId) {
  if (d.email) {
    const dup = await one(q, "select player_no, full_name from players where lower(email) = lower($1) and ($2::uuid is null or id <> $2)", [d.email, excludeId ?? null]);
    if (dup) throw conflict(`Email is already registered to ${dup.full_name} (${dup.player_no})`, "DUPLICATE_PLAYER");
  }
  if (d.contact_number) {
    const dup = await one(q, "select player_no, full_name from players where contact_number = $1 and ($2::uuid is null or id <> $2)", [d.contact_number, excludeId ?? null]);
    if (dup) throw conflict(`Contact number is already registered to ${dup.full_name} (${dup.player_no})`, "DUPLICATE_PLAYER");
  }
}
playersRouter.get("/", can("players.view"), async (req, res) => {
  const { limit, offset } = pageParams(req.query, 500);
  const params = [];
  const where = [];
  const q = str(req.query.q);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(p.full_name) like $${params.length} or lower(p.player_no) like $${params.length} or p.contact_number like $${params.length} or lower(p.email) like $${params.length})`);
  }
  const status = str(req.query.status);
  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  const membership = str(req.query.membership);
  const sql = `select * from (${PLAYER_SELECT} ${where.length ? "where " + where.join(" and ") : ""}) x
               ${membership ? `where x.membership_status = $${params.push(membership)}` : ""}
               order by x.created_at desc limit ${limit} offset ${offset}`;
  res.json((await db.query(sql, params)).rows);
});
playersRouter.post("/", can("players.manage"), async (req, res) => {
  const d = parse(schema, req.body);
  const row = await tx(async (q) => {
    await assertNoDuplicate(q, d);
    const created = await one(
      q,
      `insert into players (player_no, full_name, gender, birthday, contact_number, email, address, emergency_contact_name,
          emergency_contact_number, status, photo_url, notes, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        await numbers.player(q),
        d.full_name,
        d.gender ?? null,
        d.birthday ?? null,
        d.contact_number ?? null,
        d.email ?? null,
        d.address ?? null,
        d.emergency_contact_name ?? null,
        d.emergency_contact_number ?? null,
        d.status ?? "active",
        d.photo_url ?? null,
        d.notes ?? null,
        req.user.id
      ]
    );
    await audit(q, req, "player.register", "player", created.id, { player_no: created.player_no, full_name: created.full_name });
    return created;
  });
  res.status(201).json(row);
});
playersRouter.put("/:id", can("players.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(schema.partial(), req.body);
  const row = await tx(async (q) => {
    const before = await one(q, "select * from players where id = $1 for update", [id]);
    if (!before) throw notFound("Player");
    await assertNoDuplicate(q, d, id);
    const keys = Object.keys(d).filter((k) => d[k] !== void 0);
    if (!keys.length) return before;
    const after = await one(q, `update players set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning *`, [id, ...keys.map((k) => d[k])]);
    await audit(q, req, "player.update", "player", id, { changes: diff(before, after) });
    return after;
  });
  res.json(row);
});
playersRouter.get("/:id", can("players.view"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const player = await one(db, `${PLAYER_SELECT} where p.id = $1`, [id]);
  if (!player) throw notFound("Player");
  const [reservations, transactions, payments, rentals, memberships] = await Promise.all([
    db.query(`${RESERVATION_SELECT} where r.player_id = $1 or r.id in (select reservation_id from reservation_players where player_id = $1) order by r.start_at desc limit 100`, [id]),
    db.query(`select id, transaction_no, transaction_type, total, amount_paid, balance, status, created_at from transactions where player_id = $1 order by created_at desc limit 100`, [id]),
    db.query(`select p.id, p.method, p.amount, p.kind, p.created_at, t.transaction_no from payments p join transactions t on t.id = p.transaction_id where t.player_id = $1 order by p.created_at desc limit 100`, [id]),
    db.query(`select er.*, e.name as equipment_name from equipment_rentals er join equipment e on e.id = er.equipment_id where er.player_id = $1 order by er.rented_at desc limit 100`, [id]),
    db.query(`select pm.*, mp.name as plan_name from player_memberships pm join membership_plans mp on mp.id = pm.plan_id where pm.player_id = $1 order by pm.created_at desc`, [id])
  ]);
  res.json({ ...player, reservations: reservations.rows, transactions: transactions.rows, payments: payments.rows, rentals: rentals.rows, memberships: memberships.rows });
});

// server/routes/reports.ts
import { Router as Router5 } from "express";
var dashboardRouter = Router5();
dashboardRouter.get("/", can("dashboard.view"), async (req, res) => {
  const fin = has(req.user, "dashboard.financials");
  const stats = await one(db, `
    with pay as (select manila_date(created_at) as d, amount from payments),
         ref as (select manila_date(created_at) as d, amount from refunds)
    select
      (select coalesce(sum(amount), 0) from pay where d = manila_today()) - (select coalesce(sum(amount), 0) from ref where d = manila_today()) as today_revenue,
      (select count(*)::int from transactions where manila_date(created_at) = manila_today()) as today_transactions,
      (select count(*)::int from reservations where manila_date(start_at) = manila_today() and status not in ('cancelled','no_show')) as today_reservations,
      (select count(*)::int from courts c where c.is_active and c.status = 'available' and exists (
          select 1 from reservations r where r.court_id = c.id and r.status in ('checked_in','in_progress') and r.start_at <= now() and r.end_at > now())) as occupied_courts,
      (select count(*)::int from courts c where c.is_active and c.status = 'available' and not exists (
          select 1 from reservations r where r.court_id = c.id and r.status in ('pending','confirmed','checked_in','in_progress') and r.start_at <= now() and r.end_at > now())) as available_courts,
      (select count(*)::int from courts where is_active) as total_courts,
      (select count(*)::int from players) as total_players,
      (select count(*)::int from player_memberships where status = 'active' and manila_today() between start_date and end_date) as active_members,
      (select count(*)::int from player_memberships where status = 'active' and end_date between manila_today()
          and manila_today() + coalesce((select (value #>> '{}')::int from business_settings where key = 'membership_expiry_notice_days'), 7)) as expiring_memberships,
      (select count(*)::int from products where status = 'active' and stock_qty <= min_stock) as low_stock_products,
      (select count(*)::int from equipment_rentals where status = 'rented') as open_rentals,
      (select coalesce(sum(amount), 0) from pay where date_trunc('month', d) = date_trunc('month', manila_today()))
        - (select coalesce(sum(amount), 0) from ref where date_trunc('month', d) = date_trunc('month', manila_today())) as month_revenue,
      (select coalesce(sum(amount), 0) from expenses where status = 'approved' and date_trunc('month', expense_date) = date_trunc('month', manila_today())) as month_expenses
  `);
  if (fin) stats.net_income = m(D(stats.month_revenue).minus(stats.month_expenses));
  else for (const k of ["today_revenue", "month_revenue", "month_expenses"]) delete stats[k];
  const q = (sql, params = []) => db.query(sql, params).then((r) => r.rows);
  const [reservationStats, topCourts, topProducts, memberDist, todayReservations, daily, monthly, methods, recent] = await Promise.all([
    q(`select status, count(*)::int as count from reservations where start_at >= now() - interval '30 days' group by status order by count desc`),
    q(`select c.name, count(r.id)::int as bookings, coalesce(sum(r.duration_hours), 0)::float as hours from courts c
       left join reservations r on r.court_id = c.id and r.status not in ('cancelled','no_show') and r.start_at >= now() - interval '30 days'
       where c.is_active group by c.name, c.sort_order order by c.sort_order`),
    q(`select ti.description as name, sum(ti.quantity)::float as qty from transaction_items ti join transactions t on t.id = ti.transaction_id
       where ti.item_type = 'product' and t.created_at >= now() - interval '30 days' and t.status <> 'refunded' group by ti.description order by qty desc limit 6`),
    q(`select mp.name, count(pm.id)::int as count from membership_plans mp
       left join player_memberships pm on pm.plan_id = mp.id and pm.status = 'active' and manila_today() between pm.start_date and pm.end_date
       where mp.is_active group by mp.name, mp.sort_order order by mp.sort_order`),
    q(`${RESERVATION_SELECT} where manila_date(r.start_at) = manila_today() order by r.start_at`),
    fin ? q(`select to_char(d, 'YYYY-MM-DD') as date,
               coalesce((select sum(amount) from payments where manila_date(created_at) = d), 0)::float
             - coalesce((select sum(amount) from refunds where manila_date(created_at) = d), 0)::float as revenue
             from generate_series(manila_today() - 13, manila_today(), interval '1 day') g(d) order by d`) : [],
    fin ? q(`select to_char(mth, 'YYYY-MM') as month,
               coalesce((select sum(amount) from payments where date_trunc('month', manila_date(created_at)) = mth), 0)::float
             - coalesce((select sum(amount) from refunds where date_trunc('month', manila_date(created_at)) = mth), 0)::float as revenue,
               coalesce((select sum(amount) from expenses where status = 'approved' and date_trunc('month', expense_date) = mth), 0)::float as expenses
             from generate_series(date_trunc('month', manila_today()) - interval '5 months', date_trunc('month', manila_today()), interval '1 month') g(mth) order by mth`) : [],
    fin ? q(`select method, sum(amount)::float as amount from payments where created_at >= now() - interval '30 days' group by method order by amount desc`) : [],
    has(req.user, "transactions.view") ? q(
      `select t.id, t.transaction_no, t.customer_name, t.created_at, t.transaction_type, t.total, t.status, e.full_name as cashier_name,
                  coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '\u2014') as payment_methods
           from transactions t join employees e on e.id = t.cashier_id
           ${has(req.user, "shifts.view_all") || has(req.user, "reports.view") ? "" : "where t.cashier_id = $1"} order by t.created_at desc limit 8`,
      has(req.user, "shifts.view_all") || has(req.user, "reports.view") ? [] : [req.user.id]
    ) : []
  ]);
  res.json({
    stats,
    financials: fin,
    reservation_stats: reservationStats,
    top_courts: topCourts,
    top_products: topProducts,
    membership_distribution: memberDist,
    today_reservations: todayReservations,
    daily_revenue: daily,
    monthly_revenue: monthly,
    payment_methods: methods,
    recent_transactions: recent
  });
});
var c = (key, label, type = "text") => ({ key, label, type });
var days = `generate_series($1::date, $2::date, interval '1 day') g(d)`;
var months = `generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') g(mth)`;
var inRange = (col) => `manila_date(${col}) between $1::date and $2::date`;
var REPORTS = {
  daily_sales: {
    title: "Daily Sales",
    group: "Daily",
    chart: { x: "date", y: "net_revenue" },
    columns: [c("date", "Date", "date"), c("transactions", "Transactions", "number"), c("gross_sales", "Billed", "money"), c("discounts", "Discounts", "money"), c("collected", "Collected", "money"), c("refunds", "Refunds", "money"), c("net_revenue", "Net Revenue", "money")],
    sql: `select to_char(d, 'YYYY-MM-DD') as date,
            (select count(*)::int from transactions where manila_date(created_at) = d) as transactions,
            (select coalesce(sum(total), 0) from transactions where manila_date(created_at) = d) as gross_sales,
            (select coalesce(sum(discount_total), 0) from transactions where manila_date(created_at) = d) as discounts,
            (select coalesce(sum(amount), 0) from payments where manila_date(created_at) = d) as collected,
            (select coalesce(sum(amount), 0) from refunds where manila_date(created_at) = d) as refunds,
            (select coalesce(sum(amount), 0) from payments where manila_date(created_at) = d) - (select coalesce(sum(amount), 0) from refunds where manila_date(created_at) = d) as net_revenue
          from ${days} order by d`
  },
  daily_reservations: {
    title: "Daily Reservations",
    group: "Daily",
    chart: { x: "date", y: "total" },
    columns: [c("date", "Date", "date"), c("total", "Bookings", "number"), c("completed", "Completed", "number"), c("cancelled", "Cancelled", "number"), c("no_show", "No Show", "number"), c("hours", "Hours Booked", "number"), c("value", "Booking Value", "money")],
    sql: `select to_char(d, 'YYYY-MM-DD') as date, count(r.id)::int as total,
            count(r.id) filter (where r.status = 'completed')::int as completed, count(r.id) filter (where r.status = 'cancelled')::int as cancelled,
            count(r.id) filter (where r.status = 'no_show')::int as no_show,
            coalesce(sum(r.duration_hours) filter (where r.status not in ('cancelled','no_show')), 0)::float as hours,
            coalesce(sum(r.total_amount) filter (where r.status not in ('cancelled','no_show')), 0) as value
          from ${days} left join reservations r on manila_date(r.start_at) = d group by d order by d`
  },
  daily_transactions: {
    title: "Transaction Listing",
    group: "Daily",
    columns: [c("transaction_no", "Transaction No."), c("created_at", "Date", "datetime"), c("customer_name", "Customer"), c("transaction_type", "Type"), c("cashier", "Cashier"), c("methods", "Payment"), c("total", "Total", "money"), c("amount_paid", "Paid", "money"), c("balance", "Balance", "money"), c("status", "Status")],
    sql: `select t.transaction_no, t.created_at, t.customer_name, t.transaction_type, e.full_name as cashier, t.total, t.amount_paid, t.balance, t.status,
            coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '') as methods
          from transactions t join employees e on e.id = t.cashier_id where ${inRange("t.created_at")} order by t.created_at`
  },
  daily_expenses: {
    title: "Expenses",
    group: "Daily",
    columns: [c("expense_no", "Expense No."), c("expense_date", "Date", "date"), c("category", "Category"), c("description", "Description"), c("payment_method", "Method"), c("recorded_by", "Recorded By"), c("status", "Status"), c("amount", "Amount", "money")],
    sql: `select x.expense_no, x.expense_date, ec.name as category, x.description, x.payment_method, e.full_name as recorded_by, x.status, x.amount
          from expenses x join expense_categories ec on ec.id = x.category_id join employees e on e.id = x.recorded_by
          where x.expense_date between $1::date and $2::date order by x.expense_date, x.created_at`
  },
  cashier_summary: {
    title: "Cashier Shift Summary",
    group: "Daily",
    columns: [c("shift_no", "Shift"), c("cashier", "Cashier"), c("opened_at", "Opened", "datetime"), c("closed_at", "Closed", "datetime"), c("transactions", "Transactions", "number"), c("opening_cash", "Opening Cash", "money"), c("cash_sales", "Cash Sales", "money"), c("non_cash", "Non-cash", "money"), c("expected_cash", "Expected Cash", "money"), c("actual_cash", "Actual Cash", "money"), c("variance", "Over / (Short)", "money")],
    sql: `select s.shift_no, e.full_name as cashier, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash, s.actual_cash, s.variance,
            (select count(*)::int from transactions t where t.shift_id = s.id) as transactions,
            (select coalesce(sum(amount), 0) from payments p where p.shift_id = s.id and p.method = 'cash') as cash_sales,
            (select coalesce(sum(amount), 0) from payments p where p.shift_id = s.id and p.method <> 'cash') as non_cash
          from cashier_shifts s join employees e on e.id = s.cashier_id where ${inRange("s.opened_at")} order by s.opened_at`
  },
  court_utilization: {
    title: "Court Utilization",
    group: "Daily",
    chart: { x: "court", y: "utilization_pct" },
    columns: [c("court", "Court"), c("bookings", "Bookings", "number"), c("hours_booked", "Hours Booked", "number"), c("hours_open", "Hours Open", "number"), c("utilization_pct", "Utilization %", "number"), c("revenue", "Booking Value", "money")],
    sql: `select c.name as court,
            (select count(*)::int from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange("r.start_at")}) as bookings,
            (select coalesce(sum(r.duration_hours), 0)::float from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange("r.start_at")}) as hours_booked,
            oh.hours_open,
            case when oh.hours_open > 0 then round(100 * (select coalesce(sum(r.duration_hours), 0) from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange("r.start_at")}) / oh.hours_open::numeric, 1)::float else 0 end as utilization_pct,
            (select coalesce(sum(r.total_amount), 0) from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange("r.start_at")}) as revenue
          from courts c cross join lateral (
            select coalesce(sum(extract(epoch from (h.close_time - h.open_time)) / 3600), 0)::float as hours_open
            from ${days} join court_operating_hours h on h.court_id = c.id and h.day_of_week = extract(dow from d)::int and not h.is_closed) oh
          where c.is_active order by c.sort_order`
  },
  monthly_summary: {
    title: "Monthly Revenue, Expenses & Net Income",
    group: "Monthly",
    chart: { x: "month", y: "net_income" },
    columns: [c("month", "Month"), c("collected", "Collected", "money"), c("refunds", "Refunds", "money"), c("revenue", "Net Revenue", "money"), c("expenses", "Expenses", "money"), c("net_income", "Est. Net Operating Income", "money")],
    sql: `select month, collected, refunds, collected - refunds as revenue, expenses, collected - refunds - expenses as net_income from (
            select to_char(mth, 'YYYY-MM') as month,
              (select coalesce(sum(amount), 0) from payments where date_trunc('month', manila_date(created_at)) = mth) as collected,
              (select coalesce(sum(amount), 0) from refunds where date_trunc('month', manila_date(created_at)) = mth) as refunds,
              (select coalesce(sum(amount), 0) from expenses where status = 'approved' and date_trunc('month', expense_date) = mth) as expenses
            from ${months}) x order by month`
  },
  revenue_by_category: {
    title: "Revenue by Category (Court, Membership, Product, Service)",
    group: "Monthly",
    chart: { x: "category", y: "net_sales" },
    columns: [c("category", "Category"), c("items", "Lines", "number"), c("quantity", "Quantity", "number"), c("gross", "Gross", "money"), c("discounts", "Discounts", "money"), c("net_sales", "Net Sales", "money")],
    sql: `select case ti.item_type when 'court' then 'Court Rental' when 'membership' then 'Membership Sales' when 'product' then 'Product Sales'
                   when 'service' then 'Service Revenue' when 'equipment' then 'Equipment Rental' else 'Other Charges' end as category,
            count(*)::int as items, sum(ti.quantity)::float as quantity, sum(ti.unit_price * ti.quantity) as gross, sum(ti.discount_amount) as discounts, sum(ti.line_total) as net_sales
          from transaction_items ti join transactions t on t.id = ti.transaction_id
          where ${inRange("t.created_at")} and t.status <> 'refunded' group by 1 order by net_sales desc`
  },
  product_sales: {
    title: "Product Sales",
    group: "Monthly",
    chart: { x: "product", y: "net_sales" },
    columns: [c("product", "Product"), c("quantity", "Qty Sold", "number"), c("net_sales", "Net Sales", "money"), c("cost", "Est. Cost", "money"), c("margin", "Est. Margin", "money")],
    sql: `select ti.description as product, sum(ti.quantity)::float as quantity, sum(ti.line_total) as net_sales,
            sum(ti.quantity * coalesce(p.cost_price, 0)) as cost, sum(ti.line_total) - sum(ti.quantity * coalesce(p.cost_price, 0)) as margin
          from transaction_items ti join transactions t on t.id = ti.transaction_id left join products p on p.id = ti.ref_id
          where ti.item_type = 'product' and ${inRange("t.created_at")} and t.status <> 'refunded' group by ti.description order by net_sales desc`
  },
  service_revenue: {
    title: "Service Revenue",
    group: "Monthly",
    chart: { x: "service", y: "net_sales" },
    columns: [c("service", "Service"), c("quantity", "Quantity", "number"), c("net_sales", "Net Sales", "money")],
    sql: `select ti.description as service, sum(ti.quantity)::float as quantity, sum(ti.line_total) as net_sales
          from transaction_items ti join transactions t on t.id = ti.transaction_id
          where ti.item_type in ('service','charge') and ${inRange("t.created_at")} and t.status <> 'refunded' group by ti.description order by net_sales desc`
  },
  membership_sales: {
    title: "Membership Sales",
    group: "Monthly",
    columns: [c("membership_no", "Membership No."), c("created_at", "Sold", "datetime"), c("player", "Player"), c("plan", "Plan"), c("duration", "Duration"), c("action", "Type"), c("start_date", "Start", "date"), c("end_date", "End", "date"), c("price_paid", "Amount", "money")],
    sql: `select pm.membership_no, pm.created_at, p.full_name as player, mp.name as plan, pm.duration, pm.action, pm.start_date, pm.end_date, pm.price_paid
          from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
          where ${inRange("pm.created_at")} order by pm.created_at`
  },
  payment_methods: {
    title: "Payment Method Summary",
    group: "Monthly",
    chart: { x: "method", y: "net" },
    columns: [c("method", "Method"), c("payments", "Payments", "number"), c("collected", "Collected", "money"), c("refunded", "Refunded", "money"), c("net", "Net", "money")],
    sql: `select m.method, coalesce(p.n, 0)::int as payments, coalesce(p.amt, 0) as collected, coalesce(r.amt, 0) as refunded, coalesce(p.amt, 0) - coalesce(r.amt, 0) as net
          from (select unnest(array['cash','gcash','maya','bank_transfer','credit_card','debit_card']) as method) m
          left join (select method, count(*) as n, sum(amount) as amt from payments where ${inRange("created_at")} group by method) p on p.method = m.method
          left join (select method, sum(amount) as amt from refunds where ${inRange("created_at")} group by method) r on r.method = m.method
          order by net desc`
  },
  top_customers: {
    title: "Top Customers",
    group: "Business",
    chart: { x: "customer", y: "spent" },
    columns: [c("customer", "Customer"), c("player_no", "Player ID"), c("transactions", "Transactions", "number"), c("spent", "Total Billed", "money"), c("paid", "Net Paid", "money")],
    sql: `select t.customer_name as customer, p.player_no, count(*)::int as transactions, sum(t.total) as spent, sum(t.amount_paid - t.refunded_total) as paid
          from transactions t left join players p on p.id = t.player_id where ${inRange("t.created_at")} and t.status <> 'refunded'
          group by t.customer_name, p.player_no order by spent desc limit 50`
  },
  most_booked_courts: {
    title: "Most Booked Courts",
    group: "Business",
    chart: { x: "court", y: "bookings" },
    columns: [c("court", "Court"), c("bookings", "Bookings", "number"), c("hours", "Hours", "number"), c("value", "Booking Value", "money")],
    sql: `select c.name as court, count(r.id)::int as bookings, coalesce(sum(r.duration_hours), 0)::float as hours, coalesce(sum(r.total_amount), 0) as value
          from courts c left join reservations r on r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange("r.start_at")}
          group by c.name order by bookings desc`
  },
  peak_hours: {
    title: "Peak Booking Hours",
    group: "Business",
    chart: { x: "hour", y: "bookings" },
    columns: [c("hour", "Start Hour"), c("bookings", "Bookings", "number"), c("hours", "Hours Booked", "number")],
    sql: `select to_char(r.start_at at time zone 'Asia/Manila', 'HH24') || ':00' as hour, count(*)::int as bookings, sum(r.duration_hours)::float as hours
          from reservations r where r.status not in ('cancelled','no_show') and ${inRange("r.start_at")} group by 1 order by 1`
  },
  membership_growth: {
    title: "Membership Growth",
    group: "Business",
    chart: { x: "month", y: "new_members" },
    columns: [c("month", "Month"), c("new_members", "New", "number"), c("renewals", "Renewals", "number"), c("plan_changes", "Upgrades / Downgrades", "number"), c("sales", "Sales", "money")],
    sql: `select to_char(mth, 'YYYY-MM') as month,
            count(pm.id) filter (where pm.action = 'new')::int as new_members, count(pm.id) filter (where pm.action = 'renewal')::int as renewals,
            count(pm.id) filter (where pm.action in ('upgrade','downgrade'))::int as plan_changes, coalesce(sum(pm.price_paid), 0) as sales
          from ${months} left join player_memberships pm on date_trunc('month', manila_date(pm.created_at)) = mth group by mth order by mth`
  },
  membership_expiration: {
    title: "Membership Expiration",
    group: "Business",
    columns: [c("membership_no", "Membership No."), c("player", "Player"), c("contact_number", "Contact"), c("plan", "Plan"), c("end_date", "Expires", "date"), c("days_left", "Days Left", "number"), c("status", "Status")],
    sql: `select pm.membership_no, p.full_name as player, p.contact_number, mp.name as plan, pm.end_date, (pm.end_date - manila_today()) as days_left,
            case when pm.status = 'active' and pm.end_date < manila_today() then 'expired' else pm.status end as status
          from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
          where pm.end_date between $1::date and $2::date and pm.status in ('active','suspended','expired') order by pm.end_date`
  },
  equipment_rentals: {
    title: "Equipment Rental Summary",
    group: "Business",
    chart: { x: "equipment", y: "charges" },
    columns: [c("equipment", "Equipment"), c("rentals", "Rentals", "number"), c("units", "Units", "number"), c("free_units", "Free (Member)", "number"), c("damaged", "Damaged", "number"), c("missing", "Missing", "number"), c("charges", "Charges", "money")],
    sql: `select e.name as equipment, count(er.id)::int as rentals, coalesce(sum(er.quantity), 0)::int as units,
            coalesce(sum(er.quantity) filter (where er.is_free_entitlement), 0)::int as free_units,
            coalesce(sum(er.qty_damaged), 0)::int as damaged, coalesce(sum(er.qty_missing), 0)::int as missing, coalesce(sum(er.charge), 0) as charges
          from equipment e left join equipment_rentals er on er.equipment_id = e.id and ${inRange("er.rented_at")} group by e.name order by charges desc`
  },
  inventory_summary: {
    title: "Product Inventory & Valuation",
    group: "Business",
    noDates: true,
    columns: [c("code", "Code"), c("product", "Product"), c("category", "Category"), c("stock_qty", "In Stock", "number"), c("min_stock", "Minimum", "number"), c("stock_status", "Status"), c("cost_price", "Cost", "money"), c("selling_price", "Price", "money"), c("cost_value", "Stock Value (Cost)", "money"), c("retail_value", "Stock Value (Retail)", "money")],
    sql: `select p.code, p.name as product, pc.name as category, p.stock_qty, p.min_stock,
            case when p.stock_qty = 0 then 'Out of stock' when p.stock_qty <= p.min_stock then 'Low stock' else 'OK' end as stock_status,
            p.cost_price, p.selling_price, p.cost_price * p.stock_qty as cost_value, p.selling_price * p.stock_qty as retail_value
          from products p left join product_categories pc on pc.id = p.category_id
          where p.status = 'active' and ($1::date is not null or $2::date is not null or true) order by p.name`
  },
  cancelled_reservations: {
    title: "Cancelled & No-show Reservations",
    group: "Business",
    columns: [c("reference_no", "Reference"), c("date", "Booked For", "date"), c("court", "Court"), c("customer_name", "Customer"), c("status", "Status"), c("cancel_reason", "Reason"), c("total_amount", "Value", "money"), c("amount_paid", "Paid (unrefunded)", "money")],
    sql: `select r.reference_no, to_char(r.start_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date, c.name as court, r.customer_name, r.status, r.cancel_reason, r.total_amount, r.amount_paid
          from reservations r join courts c on c.id = r.court_id where r.status in ('cancelled','no_show') and ${inRange("r.start_at")} order by r.start_at`
  },
  refunds: {
    title: "Refund Summary",
    group: "Business",
    columns: [c("refund_no", "Refund No."), c("created_at", "Date", "datetime"), c("transaction_no", "Transaction"), c("customer_name", "Customer"), c("method", "Method"), c("reason", "Reason"), c("requested_by", "Requested By"), c("approved_by", "Approved By"), c("amount", "Amount", "money")],
    sql: `select r.refund_no, r.created_at, t.transaction_no, t.customer_name, r.method, r.reason, rq.full_name as requested_by, ap.full_name as approved_by, r.amount
          from refunds r join transactions t on t.id = r.transaction_id join employees rq on rq.id = r.requested_by join employees ap on ap.id = r.approved_by
          where ${inRange("r.created_at")} order by r.created_at`
  }
};
var reportsRouter = Router5();
reportsRouter.get("/", can("reports.view"), (_req, res) => {
  res.json(Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, group: r.group, no_dates: !!r.noDates })));
});
reportsRouter.get("/:id", can("reports.view"), async (req, res) => {
  const report = REPORTS[String(req.params.id)];
  if (!report) throw notFound("Report");
  const from = parse(zDate, req.query.from), to = parse(zDate, req.query.to);
  const { rows } = await db.query(report.sql, [from, to]);
  const totals = {};
  for (const col of report.columns.filter((x) => x.type === "money")) {
    totals[col.key] = rows.reduce((a, r) => a + Math.round(Number(r[col.key] ?? 0) * 100), 0) / 100 + "";
  }
  res.json({ id: req.params.id, title: report.title, group: report.group, columns: report.columns, chart: report.chart ?? null, from, to, rows, totals });
});

// server/routes/reservations.ts
import { Router as Router6 } from "express";
import { z as z7 } from "zod";

// server/services/checkout.ts
import { z as z6 } from "zod";
var paymentSchema = z6.object({
  method: z6.enum(PAYMENT_METHODS),
  amount: zMoney,
  reference_no: zOptText.optional()
});
var approverSchema = z6.object({ email: z6.string().email(), password: z6.string().min(1) }).nullable().optional();
var itemSchema = z6.object({
  item_type: z6.enum(["court", "product", "service", "equipment", "membership", "charge"]),
  ref_id: zOptId.optional(),
  quantity: z6.coerce.number().int().min(1).max(999).default(1),
  // equipment
  hours: z6.coerce.number().positive().max(24).optional(),
  use_entitlement: z6.boolean().optional(),
  // membership
  plan_id: zOptId.optional(),
  duration: z6.enum(["monthly", "quarterly", "semi_annual", "annual"]).optional(),
  action: z6.enum(["new", "renewal", "upgrade", "downgrade"]).optional(),
  // court: either ref_id = an existing unbilled reservation, or a new booking
  booking: bookingSchema.omit({ player_id: true, customer_name: true }).optional(),
  // ad-hoc charge
  description: zOptText.optional(),
  amount: zMoney.optional()
});
var checkoutSchema = z6.object({
  idempotency_key: z6.string().min(8).max(80),
  player_id: zOptId.optional(),
  customer_name: zOptText.optional(),
  items: z6.array(itemSchema).min(1).max(100),
  discount: z6.object({ discount_id: zOptId.optional(), code: zOptText.optional(), id_number: zOptText.optional() }).nullable().optional(),
  payments: z6.array(paymentSchema).max(8).default([]),
  allow_partial: z6.boolean().optional(),
  approver: approverSchema,
  notes: zOptText.optional(),
  /** When true nothing is saved: returns the computed totals only (used for the live POS preview). */
  preview: z6.boolean().optional()
});
var addPaymentSchema = z6.object({
  idempotency_key: z6.string().min(8).max(80),
  payments: z6.array(paymentSchema).min(1).max(8)
});
var refundSchema = z6.object({
  amount: zMoney,
  method: z6.enum(PAYMENT_METHODS),
  reason: z6.string().trim().min(3).max(500),
  restock: z6.boolean().optional(),
  approver: approverSchema
});
var SERVICE_TYPE = { coaching: "coaching", tournament: "tournament_registration" };
var PreviewRollback = class extends Error {
  constructor(payload) {
    super("preview");
    this.payload = payload;
  }
  payload;
};
function settle(payments, due) {
  for (const p of payments) if (!D(p.amount).gt(0)) throw badRequest("Each payment amount must be greater than zero");
  const nonCash = payments.filter((p) => p.method !== "cash");
  const cashTendered = sum(payments.filter((p) => p.method === "cash").map((p) => p.amount));
  const nonCashTotal = sum(nonCash.map((p) => p.amount));
  if (nonCashTotal.gt(due)) throw badRequest("Non-cash payments exceed the amount due");
  const cashApplied = minD(cashTendered, due.minus(nonCashTotal));
  const rows = nonCash.map((p) => ({ method: p.method, amount: D(p.amount), tendered: D(p.amount), reference_no: p.reference_no ?? null }));
  if (cashApplied.gt(0)) rows.push({ method: "cash", amount: cashApplied, tendered: cashTendered, reference_no: null });
  const paid = nonCashTotal.plus(cashApplied);
  return { rows, paid, change: cashTendered.minus(cashApplied), balance: due.minus(paid) };
}
async function buildLines(q, user, input, settings, membership, ip) {
  const lines = [];
  let reservationId = null;
  let walkIn = false;
  const memberPct = membership ? D(membership.court_discount_percent) : ZERO;
  const memberDiscFor = (type, gross) => membership && settings.member_discount_types.includes(type) ? r2(gross.times(memberPct).div(100)) : ZERO;
  const base = (l) => ({
    ref_id: null,
    memberDisc: memberDiscFor(l.item_type, l.gross),
    manualDisc: ZERO,
    vatExempt: false,
    meta: {},
    ...l
  });
  for (const it of input.items) {
    const qty = it.quantity;
    if (it.item_type === "product") {
      const p = await one(q, "select * from products where id = $1", [it.ref_id]);
      if (!p || p.status !== "active") throw notFound("Product");
      const price = D(p.selling_price);
      lines.push(base({
        item_type: "product",
        ref_id: p.id,
        description: p.name,
        quantity: qty,
        unit_price: price,
        gross: r2(price.times(qty)),
        meta: { code: p.code },
        apply: async (txId) => {
          const upd = await one(q, "update products set stock_qty = stock_qty - $2 where id = $1 and stock_qty >= $2 returning stock_qty", [p.id, qty]);
          if (!upd) throw conflict(`Not enough stock for ${p.name}`, "OUT_OF_STOCK");
          await q.query(
            `insert into inventory_movements (product_id, movement_type, quantity, balance_after, unit_cost, transaction_id, notes, created_by)
             values ($1, 'sale', $2, $3, $4, $5, 'POS sale', $6)`,
            [p.id, -qty, upd.stock_qty, p.cost_price, txId, user.id]
          );
        }
      }));
    } else if (it.item_type === "service") {
      const s = await one(q, "select * from services where id = $1", [it.ref_id]);
      if (!s || !s.is_active) throw notFound("Service");
      const price = D(s.price);
      lines.push(base({
        item_type: "service",
        ref_id: s.id,
        description: s.name,
        quantity: qty,
        unit_price: price,
        gross: r2(price.times(qty)),
        meta: { code: s.code, category: s.category, charge_method: s.charge_method }
      }));
    } else if (it.item_type === "equipment") {
      const e = await one(q, "select * from equipment where id = $1", [it.ref_id]);
      if (!e || !e.is_active) throw notFound("Equipment");
      const hours = e.charge_method === "per_hour" ? it.hours ?? 1 : null;
      let unit = e.charge_method === "per_hour" ? r2(D(e.rental_rate).times(hours)) : D(e.rental_rate);
      const free = !!it.use_entitlement;
      if (free) {
        if (!membership) throw badRequest("Free rentals are only available to players with a valid membership");
        if (!e.entitlement_type || !(membership.free_paddle_rentals_per_month > 0)) throw badRequest(`${e.name} is not covered by this membership`);
        unit = ZERO;
      }
      const customer = input.customer_name ?? "Walk-in Customer";
      lines.push(base({
        item_type: "equipment",
        ref_id: e.id,
        quantity: qty,
        unit_price: unit,
        gross: r2(unit.times(qty)),
        description: `${e.name} rental${hours ? ` (${hours} hr)` : ""}${free ? " \u2014 member free rental" : ""}`,
        meta: { code: e.code, hours, free_entitlement: free },
        apply: async (txId) => {
          if (free) {
            await q.query(
              `insert into membership_entitlements (membership_id, entitlement_type, period_start, quantity_total)
               values ($1, $2, date_trunc('month', manila_today())::date, $3)
               on conflict (membership_id, entitlement_type, period_start) do nothing`,
              [membership.id, e.entitlement_type, membership.free_paddle_rentals_per_month]
            );
            const used = await one(
              q,
              `update membership_entitlements set quantity_used = quantity_used + $3
               where membership_id = $1 and entitlement_type = $2 and period_start = date_trunc('month', manila_today())::date
                 and quantity_used + $3 <= quantity_total returning id`,
              [membership.id, e.entitlement_type, qty]
            );
            if (!used) throw conflict("No free rentals left for this month", "ENTITLEMENT_USED");
          }
          const upd = await one(q, "update equipment set available_qty = available_qty - $2 where id = $1 and available_qty >= $2 returning id", [e.id, qty]);
          if (!upd) throw conflict(`Not enough ${e.name} available to rent`, "EQUIPMENT_UNAVAILABLE");
          await q.query(
            `insert into equipment_rentals (rental_no, equipment_id, player_id, customer_name, quantity, expected_return_at, charge,
                is_free_entitlement, transaction_id, issued_by)
             values ($1,$2,$3,$4,$5, case when $6::numeric is null then null else now() + ($6::numeric * interval '1 hour') end, $7,$8,$9,$10)`,
            [await numbers.rental(q), e.id, input.player_id ?? null, customer, qty, hours, m(unit.times(qty)), free, txId, user.id]
          );
        }
      }));
    } else if (it.item_type === "membership") {
      if (!input.player_id) throw badRequest("Select a registered player before selling a membership");
      if (lines.some((l) => l.item_type === "membership")) throw badRequest("Only one membership can be sold per transaction");
      const plan = await one(q, "select * from membership_plans where id = $1 and is_active", [it.plan_id ?? it.ref_id]);
      if (!plan) throw notFound("Membership plan");
      const duration = it.duration ?? "monthly";
      const months2 = settings.duration_months[duration];
      if (!months2) throw badRequest("Unknown membership duration");
      await q.query(`update player_memberships set status = 'expired' where player_id = $1 and status = 'active' and end_date < manila_today()`, [input.player_id]);
      const current = await one(q, `select pm.*, mp.monthly_price as current_price from player_memberships pm join membership_plans mp on mp.id = pm.plan_id
                                    where pm.player_id = $1 and pm.status in ('active','suspended') for update of pm`, [input.player_id]);
      const last = current ?? await one(q, "select * from player_memberships where player_id = $1 order by created_at desc limit 1", [input.player_id]);
      let action = it.action ?? (current ? "renewal" : "new");
      if (action === "new" && current) throw conflict("This player already has a membership. Use Renew, Upgrade or Downgrade instead", "HAS_MEMBERSHIP");
      if ((action === "upgrade" || action === "downgrade") && !current) throw badRequest("There is no current membership to change");
      if ((action === "upgrade" || action === "downgrade") && current.plan_id === plan.id) throw badRequest("Choose a different plan to upgrade or downgrade");
      if (action === "renewal" && current && current.plan_id !== plan.id) {
        action = D(plan.monthly_price).gt(current.current_price) ? "upgrade" : "downgrade";
      }
      if (current?.status === "suspended") throw conflict("This membership is suspended. Resume or cancel it first");
      const price = r2(D(plan.monthly_price).times(months2));
      const carryOn = action === "renewal" && current;
      lines.push(base({
        item_type: "membership",
        ref_id: plan.id,
        quantity: 1,
        unit_price: price,
        gross: price,
        description: `${plan.name} \u2014 ${duration.replace("_", "-")} (${action})`,
        meta: { plan_code: plan.code, duration, action, months: months2 },
        apply: async (txId) => {
          if (current) await q.query(`update player_memberships set status = 'replaced', status_reason = $2, status_changed_at = now(), status_changed_by = $3 where id = $1`, [current.id, action, user.id]);
          const mem = await one(
            q,
            `insert into player_memberships (membership_no, player_id, plan_id, duration, action, start_date, end_date, price_paid, transaction_id, previous_membership_id, created_by)
             select $1, $2::uuid, $3::uuid, $4, $5, s.start_date, (s.term_start + make_interval(months => $6::int) - interval '1 day')::date, $7::numeric, $8::uuid, $9::uuid, $10::uuid
             from (select case when $11::boolean then $12::date else manila_today() end as start_date,
                          case when $11::boolean then greatest($13::date + 1, manila_today()) else manila_today() end as term_start) s
             returning *`,
            [
              await numbers.membership(q),
              input.player_id,
              plan.id,
              duration,
              action,
              months2,
              m(price),
              txId,
              last?.id ?? null,
              user.id,
              !!carryOn,
              current?.start_date ?? null,
              current?.end_date ?? null
            ]
          );
          await audit(q, { user, ip }, `membership.${action}`, "membership", mem.id, {
            membership_no: mem.membership_no,
            plan: plan.name,
            duration,
            start_date: mem.start_date,
            end_date: mem.end_date
          });
        }
      }));
    } else if (it.item_type === "court") {
      if (reservationId) throw badRequest("Only one court booking can be paid per transaction");
      let res;
      if (it.booking) {
        const created = await createReservation(q, user, { ...it.booking, player_id: input.player_id ?? null, customer_name: input.customer_name ?? null, is_walk_in: it.booking.is_walk_in ?? true }, ip);
        res = created.reservation;
        walkIn = !input.player_id;
      } else {
        res = await one(q, "select * from reservations where id = $1 for update", [it.ref_id]);
        if (!res) throw notFound("Reservation");
        if (!LIVE_STATUSES.includes(res.status) && res.status !== "completed") throw conflict(`Reservation ${res.reference_no} is ${res.status.replace("_", " ")}`);
        const billed = await one(q, "select transaction_no from transactions where reservation_id = $1 limit 1", [res.id]);
        if (billed) throw conflict(`Reservation ${res.reference_no} is already billed on ${billed.transaction_no}. Add a balance payment to that transaction instead`, "ALREADY_BILLED");
      }
      reservationId = res.id;
      const court = await one(q, "select name from courts where id = $1", [res.court_id]);
      const when = await one(q, `select to_char($1::timestamptz at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM') as s`, [res.start_at]);
      const gross = D(res.rate_amount);
      lines.push(base({
        item_type: "court",
        ref_id: res.id,
        quantity: 1,
        unit_price: gross,
        gross,
        description: `${court.name} \u2014 ${when.s} (${Number(res.duration_hours)} hr)`,
        meta: { reference_no: res.reference_no, rate_type: res.rate_type, duration_hours: Number(res.duration_hours) }
      }));
    } else {
      if (!it.description || !it.amount) throw badRequest("An additional charge needs a description and an amount");
      const price = D(it.amount);
      lines.push(base({ item_type: "charge", description: it.description, quantity: qty, unit_price: price, gross: r2(price.times(qty)), memberDisc: ZERO }));
    }
  }
  return { lines, reservationId, walkIn };
}
async function applyManualDiscount(q, user, input, settings, lines) {
  const req = input.discount;
  if (!req || !req.discount_id && !req.code) return null;
  const d = req.discount_id ? await one(q, "select * from discounts where id = $1", [req.discount_id]) : await one(q, "select * from discounts where upper(code) = upper($1)", [req.code]);
  if (!d || !d.is_active) throw badRequest("That discount or promo code is not valid", "DISCOUNT_INVALID");
  const today = (await one(q, "select manila_today()::text as d")).d;
  if (d.valid_from && today < d.valid_from || d.valid_to && today > d.valid_to) throw badRequest(`${d.name} is not valid today`, "DISCOUNT_INVALID");
  if (d.usage_limit !== null && d.usage_count >= d.usage_limit) throw badRequest(`${d.name} has reached its usage limit`, "DISCOUNT_INVALID");
  const statutory = d.discount_type === "senior" || d.discount_type === "pwd";
  if (statutory && !req.id_number) throw badRequest("Enter the Senior Citizen / PWD ID number to apply this discount", "ID_REQUIRED");
  const types = statutory ? settings.sc_pwd_eligible_types : d.applies_to ?? [];
  const eligible = lines.filter((l) => (types.length === 0 || types.includes(l.item_type)) && l.gross.gt(0));
  if (!eligible.length) throw badRequest(`${d.name} does not apply to any item in this order`, "DISCOUNT_INVALID");
  const stack = !!d.stackable_with_membership;
  const baseOf = (l) => stack ? l.gross.minus(l.memberDisc) : l.gross;
  const eligibleTotal = sum(eligible.map(baseOf));
  if (eligibleTotal.lt(d.min_amount)) throw badRequest(`${d.name} requires a minimum of \u20B1${m(d.min_amount)} on eligible items`, "DISCOUNT_INVALID");
  let approvedBy = null;
  if (d.requires_approval) {
    approvedBy = has(user, "discounts.approve") ? user.id : (await verifyApprover(q, input.approver, "discounts.approve")).id;
  }
  if (statutory) {
    const rate = D(settings.sc_pwd_discount_rate).div(100);
    const vat = D(settings.vat_rate).div(100);
    for (const l of eligible) {
      const b = baseOf(l);
      if (settings.vat_registered) {
        const net = r2(b.div(vat.plus(1)).times(D(1).minus(rate)));
        l.manualDisc = b.minus(net);
        l.vatExempt = true;
      } else {
        l.manualDisc = r2(b.times(rate));
      }
    }
  } else if (d.value_type === "percent") {
    for (const l of eligible) l.manualDisc = r2(baseOf(l).times(d.value).div(100));
  } else {
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
      for (const l of lines) l.memberDisc = ZERO;
    } else {
      for (const l of lines) {
        l.manualDisc = ZERO;
        l.vatExempt = false;
      }
      return { discount: d, applied: false, approvedBy: null, note: `Membership discount is larger than ${d.name}, so the membership discount was kept` };
    }
  }
  return { discount: d, applied: true, approvedBy, note: null };
}
async function checkout(q, user, input, ip) {
  if (!input.preview) {
    const replay = await one(q, "select id from transactions where idempotency_key = $1", [input.idempotency_key]);
    if (replay) return { ...await getTransaction(q, replay.id), replayed: true };
  }
  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (!input.preview && settings.require_open_shift && !shift) throw conflict("Open a cashier shift before accepting payments", "NO_SHIFT");
  let customerName = input.customer_name ?? null;
  if (input.player_id) {
    const player = await one(q, "select * from players where id = $1", [input.player_id]);
    if (!player) throw notFound("Player");
    customerName = player.full_name;
  }
  input = { ...input, customer_name: customerName };
  const membership = await activeMembership(q, input.player_id) ?? null;
  const { lines, reservationId, walkIn } = await buildLines(q, user, input, settings, membership, ip);
  const manual = await applyManualDiscount(q, user, input, settings, lines);
  const lineDisc = (l) => l.memberDisc.plus(l.manualDisc);
  const lineTotal = (l) => l.gross.minus(lineDisc(l));
  const subtotal = sum(lines.map((l) => l.gross));
  const discountTotal = sum(lines.map(lineDisc));
  const total = subtotal.minus(discountTotal);
  if (total.lt(0)) throw badRequest("Discounts exceed the order total");
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
    manual?.applied ? manual.discount.name : null
  ].filter(Boolean);
  const summary = {
    customer_name: customerName ?? "Walk-in Customer",
    membership: membership ? { plan_name: membership.plan_name, end_date: membership.end_date, discount_percent: membership.court_discount_percent } : null,
    lines: lines.map((l) => ({
      item_type: l.item_type,
      ref_id: l.ref_id,
      description: l.description,
      quantity: l.quantity,
      unit_price: m(l.unit_price),
      discount_amount: m(lineDisc(l)),
      line_total: m(lineTotal(l))
    })),
    subtotal: m(subtotal),
    discount_total: m(discountTotal),
    member_discount: m(memberTotal),
    manual_discount: m(manualTotal),
    discount_label: labels.join(" + ") || null,
    discount_note: manual?.note ?? null,
    total: m(total),
    vatable_sales: m(vatable),
    vat_amount: m(vatAmount),
    vat_exempt_sales: m(vatExempt)
  };
  if (input.preview) throw new PreviewRollback(summary);
  const pay = settle(input.payments, total);
  if (pay.balance.gt(0)) {
    if (!input.allow_partial) throw badRequest(`Payment is short by \u20B1${m(pay.balance)}`, "UNDERPAID");
    if (!input.player_id && !input.customer_name) throw badRequest("A customer name is required to leave a balance", "UNDERPAID");
  }
  const types = [...new Set(lines.map((l) => {
    if (l.item_type === "court") return walkIn ? "walk_in" : "court_rental";
    if (l.item_type === "product") return "product_purchase";
    if (l.item_type === "equipment") return "equipment_rental";
    if (l.item_type === "membership") return l.meta.action === "new" ? "membership_registration" : "membership_renewal";
    if (l.item_type === "service") return SERVICE_TYPE[String(l.meta.category)] ?? "service";
    return "other_charges";
  }))];
  const trx = await one(
    q,
    `insert into transactions (transaction_no, transaction_type, player_id, customer_name, reservation_id, shift_id, cashier_id,
        subtotal, discount_total, total, vatable_sales, vat_amount, vat_exempt_sales, amount_paid, balance, change_due, status,
        discount_id, discount_label, discount_id_number, approved_by, idempotency_key, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning *`,
    [
      await numbers.transaction(q),
      types.length === 1 ? types[0] : "mixed",
      input.player_id ?? null,
      summary.customer_name,
      reservationId,
      shift?.id ?? null,
      user.id,
      m(subtotal),
      m(discountTotal),
      m(total),
      m(vatable),
      m(vatAmount),
      m(vatExempt),
      m(pay.paid),
      m(pay.balance),
      m(pay.change),
      pay.balance.gt(0) ? "partial" : "completed",
      manual?.applied ? manual.discount.id : null,
      summary.discount_label,
      manual?.applied ? input.discount?.id_number ?? null : null,
      manual?.approvedBy ?? null,
      input.idempotency_key,
      input.notes ?? null
    ]
  );
  for (const l of lines) {
    await q.query(
      `insert into transaction_items (transaction_id, item_type, ref_id, description, quantity, unit_price, discount_amount, line_total, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trx.id, l.item_type, l.ref_id, l.description, l.quantity, m(l.unit_price), m(lineDisc(l)), m(lineTotal(l)), JSON.stringify({ ...l.meta, vat_exempt: l.vatExempt })]
    );
    if (l.apply) await l.apply(trx.id);
  }
  for (const p of pay.rows) {
    await q.query(
      `insert into payments (transaction_id, reservation_id, shift_id, kind, method, amount, tendered, reference_no, received_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trx.id, reservationId, shift?.id ?? null, reservationId && pay.balance.gt(0) ? "deposit" : "payment", p.method, m(p.amount), m(p.tendered), p.reference_no, user.id]
    );
  }
  if (manual?.applied) {
    const used = await one(q, "update discounts set usage_count = usage_count + 1 where id = $1 and (usage_limit is null or usage_count < usage_limit) returning id", [manual.discount.id]);
    if (!used) throw conflict(`${manual.discount.name} has reached its usage limit`, "DISCOUNT_INVALID");
    await q.query(
      `insert into discount_usage (kind, discount_id, transaction_id, player_id, amount, approved_by) values ('discount',$1,$2,$3,$4,$5)`,
      [manual.discount.id, trx.id, input.player_id ?? null, m(manualTotal), manual.approvedBy]
    );
  }
  if (memberTotal.gt(0)) {
    await q.query(
      `insert into discount_usage (kind, membership_id, transaction_id, player_id, amount) values ('membership',$1,$2,$3,$4)`,
      [membership.id, trx.id, input.player_id, m(memberTotal)]
    );
  }
  if (reservationId) {
    const courtLine = lines.find((l) => l.item_type === "court");
    await q.query(
      `update reservations set discount_amount = $2, total_amount = $3, amount_paid = amount_paid + $4, updated_by = $5,
              status = case when status = 'pending' and ($4::numeric > 0 or $3::numeric = 0) then 'confirmed' else status end
       where id = $1`,
      [reservationId, m(lineDisc(courtLine)), m(lineTotal(courtLine)), m(minD(pay.paid, lineTotal(courtLine))), user.id]
    );
  }
  await audit(q, { user, ip }, "transaction.complete", "transaction", trx.id, {
    transaction_no: trx.transaction_no,
    total: m(total),
    paid: m(pay.paid),
    balance: m(pay.balance),
    methods: pay.rows.map((p) => p.method),
    discount: summary.discount_label,
    approved_by: manual?.approvedBy ?? void 0
  });
  return { ...await getTransaction(q, trx.id), discount_note: summary.discount_note };
}
async function addPayment(q, user, txId, input, ip) {
  const dup = await one(q, "select transaction_id from payments where idempotency_key = $1", [input.idempotency_key]);
  if (dup) return getTransaction(q, dup.transaction_id);
  const trx = await one(q, "select * from transactions where id = $1 for update", [txId]);
  if (!trx) throw notFound("Transaction");
  if (trx.status !== "partial" || !D(trx.balance).gt(0)) throw conflict("This transaction has no outstanding balance");
  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (settings.require_open_shift && !shift) throw conflict("Open a cashier shift before accepting payments", "NO_SHIFT");
  const pay = settle(input.payments, D(trx.balance));
  if (!pay.paid.gt(0)) throw badRequest("Enter a payment amount");
  let first = true;
  for (const p of pay.rows) {
    await q.query(
      `insert into payments (transaction_id, reservation_id, shift_id, kind, method, amount, tendered, reference_no, received_by, idempotency_key)
       values ($1,$2,$3,'balance',$4,$5,$6,$7,$8,$9)`,
      [trx.id, trx.reservation_id, shift?.id ?? null, p.method, m(p.amount), m(p.tendered), p.reference_no, user.id, first ? input.idempotency_key : null]
    );
    first = false;
  }
  await q.query(
    `update transactions set amount_paid = amount_paid + $2, balance = $3, change_due = $4, status = $5 where id = $1`,
    [trx.id, m(pay.paid), m(pay.balance), m(pay.change), pay.balance.gt(0) ? "partial" : "completed"]
  );
  if (trx.reservation_id) {
    await q.query(`update reservations set amount_paid = least(total_amount, amount_paid + $2), updated_by = $3 where id = $1`, [trx.reservation_id, m(pay.paid), user.id]);
  }
  await audit(q, { user, ip }, "payment.balance", "transaction", trx.id, { transaction_no: trx.transaction_no, paid: m(pay.paid), balance: m(pay.balance) });
  return getTransaction(q, trx.id);
}
async function refund(q, user, txId, input, ip) {
  const trx = await one(q, "select * from transactions where id = $1 for update", [txId]);
  if (!trx) throw notFound("Transaction");
  const amount = D(input.amount);
  const refundable = D(trx.amount_paid).minus(trx.refunded_total);
  if (!amount.gt(0)) throw badRequest("Refund amount must be greater than zero");
  if (amount.gt(refundable)) throw badRequest(`At most \u20B1${m(refundable)} can be refunded on this transaction`);
  const approver = has(user, "refunds.approve") ? user : await verifyApprover(q, input.approver, "refunds.approve");
  if (!has(user, "refunds.request") && !has(user, "refunds.approve")) throw forbidden();
  const settings = await getSettings(q);
  const shift = await openShift(q, user.id);
  if (input.method === "cash" && settings.require_open_shift && !shift) throw conflict("Open a cashier shift before refunding cash", "NO_SHIFT");
  const full = amount.eq(refundable) && D(trx.refunded_total).plus(amount).eq(trx.amount_paid);
  const restock = !!input.restock && full;
  const row = await one(
    q,
    `insert into refunds (refund_no, transaction_id, shift_id, amount, method, reason, restocked, requested_by, approved_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [await numbers.refund(q), trx.id, shift?.id ?? null, m(amount), input.method, input.reason, restock, user.id, approver.id]
  );
  await q.query(`update transactions set refunded_total = refunded_total + $2, status = $3 where id = $1`, [trx.id, m(amount), full ? "refunded" : "partially_refunded"]);
  if (full) {
    const { rows: items } = await q.query("select * from transaction_items where transaction_id = $1", [trx.id]);
    for (const it of items) {
      if (it.item_type === "product" && restock) {
        const upd = await one(q, "update products set stock_qty = stock_qty + $2 where id = $1 returning stock_qty", [it.ref_id, Number(it.quantity)]);
        if (upd) {
          await q.query(
            `insert into inventory_movements (product_id, movement_type, quantity, balance_after, transaction_id, notes, created_by)
             values ($1, 'refund', $2, $3, $4, $5, $6)`,
            [it.ref_id, Number(it.quantity), upd.stock_qty, trx.id, `Refund ${row.refund_no}`, user.id]
          );
        }
      }
      if (it.item_type === "membership") {
        await q.query(
          `update player_memberships set status = 'cancelled', status_reason = $2, status_changed_at = now(), status_changed_by = $3
           where transaction_id = $1 and status in ('active','suspended')`,
          [trx.id, `Refunded (${row.refund_no})`, user.id]
        );
      }
    }
  }
  if (trx.reservation_id) {
    await q.query("update reservations set amount_paid = greatest(0, amount_paid - $2), updated_by = $3 where id = $1", [trx.reservation_id, m(amount), user.id]);
  }
  await audit(q, { user, ip }, "refund.process", "transaction", trx.id, {
    transaction_no: trx.transaction_no,
    refund_no: row.refund_no,
    amount: m(amount),
    method: input.method,
    reason: input.reason,
    approved_by: approver.full_name,
    restocked: restock
  });
  return getTransaction(q, trx.id);
}
async function getTransaction(q, id) {
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
    [id]
  );
  if (!trx) throw notFound("Transaction");
  const items = await q.query("select * from transaction_items where transaction_id = $1 order by created_at, id", [id]);
  const payments = await q.query(`select p.*, e.full_name as received_by_name from payments p join employees e on e.id = p.received_by where p.transaction_id = $1 order by p.created_at`, [id]);
  const refunds = await q.query(`select r.*, rq.full_name as requested_by_name, ap.full_name as approved_by_name from refunds r
             join employees rq on rq.id = r.requested_by join employees ap on ap.id = r.approved_by where r.transaction_id = $1 order by r.created_at`, [id]);
  return { ...trx, items: items.rows, payments: payments.rows, refunds: refunds.rows };
}

// server/routes/reservations.ts
var courtsRouter = Router6();
courtsRouter.get("/board", can("courts.view"), async (_req, res) => {
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
courtsRouter.get("/:id/hours", can("courts.view"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { rows } = await db.query("select day_of_week, open_time, close_time, is_closed from court_operating_hours where court_id = $1 order by day_of_week", [id]);
  res.json(Array.from({ length: 7 }, (_, d) => rows.find((r) => r.day_of_week === d) ?? { day_of_week: d, open_time: "06:00:00", close_time: "22:00:00", is_closed: false }));
});
courtsRouter.put("/:id/hours", can("courts.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const hours = parse(z7.array(z7.object({ day_of_week: z7.number().int().min(0).max(6), open_time: zTime, close_time: zTime, is_closed: z7.boolean() })).length(7), req.body);
  await tx(async (q) => {
    for (const h of hours) {
      if (h.close_time <= h.open_time) throw badRequest("Closing time must be after opening time");
      await q.query(
        `insert into court_operating_hours (court_id, day_of_week, open_time, close_time, is_closed) values ($1,$2,$3,$4,$5)
         on conflict (court_id, day_of_week) do update set open_time = excluded.open_time, close_time = excluded.close_time, is_closed = excluded.is_closed`,
        [id, h.day_of_week, h.open_time, h.close_time, h.is_closed]
      );
    }
    await audit(q, req, "court.hours_update", "court", id, { hours });
  });
  res.json({ ok: true });
});
courtsRouter.use("/", crud({
  table: "courts",
  entity: "court",
  view: ["courts.view"],
  manage: ["courts.manage"],
  orderBy: "t.sort_order, t.name",
  search: ["name", "code"],
  schema: z7.object({
    code: zText,
    name: zText,
    description: zOptText.optional(),
    court_type: z7.enum(["indoor", "outdoor", "covered"]).default("indoor"),
    hourly_rate: zMoney,
    status: z7.enum(["available", "maintenance", "closed"]).default("available"),
    is_active: zBool.default(true),
    sort_order: z7.coerce.number().int().default(0)
  }),
  softDelete: { column: "is_active", value: false },
  afterCreate: async (q, row) => {
    await q.query(`insert into court_operating_hours (court_id, day_of_week) select $1, d from generate_series(0, 6) d on conflict do nothing`, [row.id]);
  }
}));
var reservationsRouter = Router6();
reservationsRouter.get("/", can("reservations.view"), async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql2, v) => {
    params.push(v);
    where.push(sql2.replace("?", `$${params.length}`));
  };
  if (str(req.query.from)) add(`manila_date(r.start_at) >= ?::date`, parse(zDate, req.query.from));
  if (str(req.query.to)) add(`manila_date(r.start_at) <= ?::date`, parse(zDate, req.query.to));
  if (str(req.query.status)) add(`r.status = any(?::text[])`, String(req.query.status).split(","));
  if (str(req.query.court_id)) add(`r.court_id = ?`, parse(zId, req.query.court_id));
  if (str(req.query.player_id)) add(`r.player_id = ?`, parse(zId, req.query.player_id));
  if (str(req.query.q)) add(`(lower(r.customer_name) like ? or lower(r.reference_no) like ?)`.replaceAll("?", `$${params.length + 1}`), `%${String(req.query.q).toLowerCase()}%`);
  if (req.query.unbilled === "true") {
    where.push(`r.status = any('{pending,confirmed,checked_in,in_progress,completed}') and not exists (select 1 from transactions t where t.reservation_id = r.id) and r.total_amount > 0`);
  }
  const sql = `${RESERVATION_SELECT} ${where.length ? "where " + where.join(" and ") : ""} order by r.start_at ${req.query.order === "desc" ? "desc" : "asc"} limit 1000`;
  res.json((await db.query(sql, params)).rows);
});
reservationsRouter.get("/availability", can("reservations.view"), async (req, res) => {
  const date = parse(zDate, req.query.date);
  const duration = Number(req.query.duration ?? 1);
  if (!(duration > 0)) throw badRequest("Invalid duration");
  const settings = await getSettings(db);
  const step = settings.booking_slot_minutes === 30 ? 30 : 60;
  const meta = await one(db, `select extract(dow from $1::date)::int as dow, ($1::date = manila_today()) as is_today, ($1::date < manila_today()) as is_past,
       (extract(hour from now() at time zone 'Asia/Manila') * 60 + extract(minute from now() at time zone 'Asia/Manila'))::int as now_min`, [date]);
  const [courts, hours, booked] = await Promise.all([
    db.query("select * from courts where is_active order by sort_order, name"),
    db.query("select * from court_operating_hours where day_of_week = $1", [meta.dow]),
    db.query(
      `select r.id, r.court_id, r.reference_no, r.customer_name, r.status,
              (extract(epoch from (r.start_at at time zone 'Asia/Manila')::time) / 60)::int as start_min,
              (extract(epoch from (r.start_at at time zone 'Asia/Manila')::time) / 60)::int + (r.duration_hours * 60)::int as end_min
       from reservations r where manila_date(r.start_at) = $1::date and r.status = any($2::text[])`,
      [date, LIVE_STATUSES]
    )
  ]);
  const toMin2 = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  res.json({
    date,
    duration,
    step,
    courts: courts.rows.map((c2) => {
      const h = hours.rows.find((x) => x.court_id === c2.id);
      const open = toMin2(h?.open_time ?? "06:00"), close = toMin2(h?.close_time ?? "22:00");
      const bookings = booked.rows.filter((b) => b.court_id === c2.id);
      const bookable = c2.status === "available" && !h?.is_closed && !meta.is_past;
      const slots = [];
      for (let t = open; t < close; t += step) {
        const end = t + duration * 60;
        const taken = bookings.find((b) => t < b.end_min && end > b.start_min);
        const occupant = bookings.find((b) => t >= b.start_min && t < b.end_min);
        slots.push({
          time: fmt(t),
          available: bookable && !taken && end <= close && !(meta.is_today && end <= meta.now_min),
          reservation: occupant ? { id: occupant.id, reference_no: occupant.reference_no, customer_name: occupant.customer_name, status: occupant.status } : null
        });
      }
      return { id: c2.id, name: c2.name, status: c2.status, court_type: c2.court_type, is_closed: !!h?.is_closed, open_time: fmt(open), close_time: fmt(close), slots };
    })
  });
});
reservationsRouter.post("/quote", can("reservations.view"), async (req, res) => {
  const { court, membership, ...quote } = await quoteCourt(db, parse(bookingSchema, req.body));
  res.json({ ...quote, court_name: court.name, membership: membership ? { plan_name: membership.plan_name, end_date: membership.end_date } : null });
});
reservationsRouter.post("/", can("reservations.manage"), async (req, res) => {
  const body = parse(bookingSchema.extend({
    idempotency_key: z7.string().min(8).max(80).optional(),
    payments: checkoutSchema.shape.payments.optional(),
    discount: checkoutSchema.shape.discount,
    approver: checkoutSchema.shape.approver
  }), req.body);
  const { payments, idempotency_key, discount, approver, ...booking } = body;
  const paying = !!payments?.length;
  if (paying && !has(req.user, "pos.use")) throw forbidden("Only cashiers can accept payments. Save the reservation as pending instead");
  if (paying && !idempotency_key) throw badRequest("idempotency_key is required when paying");
  const result = await tx(async (q) => {
    if (paying) {
      const { player_id, customer_name, ...slot } = booking;
      const trx = await checkout(q, req.user, parse(checkoutSchema, {
        idempotency_key,
        player_id,
        customer_name,
        discount,
        approver,
        payments,
        allow_partial: true,
        items: [{ item_type: "court", booking: { ...slot, is_walk_in: booking.is_walk_in ?? false } }]
      }), req.ip);
      return { reservation: await getReservation(q, trx.reservation_id), transaction: trx };
    }
    const { reservation } = await createReservation(q, req.user, booking, req.ip);
    return { reservation: await getReservation(q, reservation.id), transaction: null };
  });
  res.status(201).json(result);
});
reservationsRouter.get("/:id", can("reservations.view"), async (req, res) => {
  const row = await getReservation(db, parse(zId, req.params.id));
  const players = await db.query("select p.id, p.player_no, p.full_name from reservation_players rp join players p on p.id = rp.player_id where rp.reservation_id = $1", [row.id]);
  res.json({ ...row, extra_players: players.rows });
});
var TRANSITIONS = {
  pending: ["confirmed", "checked_in", "no_show"],
  confirmed: ["checked_in", "no_show"],
  checked_in: ["in_progress", "completed"],
  in_progress: ["completed"]
};
reservationsRouter.post("/:id/status", can("reservations.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { status } = parse(z7.object({ status: z7.enum(["confirmed", "checked_in", "in_progress", "completed", "no_show"]) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, "select * from reservations where id = $1 for update", [id]);
    if (!r) throw notFound("Reservation");
    if (!TRANSITIONS[r.status]?.includes(status)) throw conflict(`A ${r.status.replace("_", " ")} reservation cannot be marked ${status.replace("_", " ")}`);
    await q.query(
      `update reservations set status = $2, updated_by = $3,
          checked_in_at = case when $2 = 'checked_in' then now() else checked_in_at end,
          completed_at = case when $2 = 'completed' then now() else completed_at end
       where id = $1`,
      [id, status, req.user.id]
    );
    await audit(q, req, `reservation.${status}`, "reservation", id, { reference_no: r.reference_no, from: r.status });
    return getReservation(q, id);
  });
  res.json(row);
});
reservationsRouter.post("/:id/cancel", can("reservations.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { reason } = parse(z7.object({ reason: z7.string().trim().min(3).max(500) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, "select * from reservations where id = $1 for update", [id]);
    if (!r) throw notFound("Reservation");
    if (!["pending", "confirmed", "checked_in"].includes(r.status)) throw conflict(`A ${r.status.replace("_", " ")} reservation cannot be cancelled`);
    await q.query(`update reservations set status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_by = $3 where id = $1`, [id, reason, req.user.id]);
    await audit(q, req, "reservation.cancel", "reservation", id, { reference_no: r.reference_no, reason, amount_paid: r.amount_paid });
    return getReservation(q, id);
  });
  res.json(row);
});
reservationsRouter.put("/:id/reschedule", can("reservations.manage"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z7.object({ court_id: zId, date: zDate, start_time: zTime, duration_hours: z7.coerce.number().positive().max(24) }), req.body);
  const row = await tx(async (q) => {
    const r = await one(q, "select * from reservations where id = $1 for update", [id]);
    if (!r) throw notFound("Reservation");
    if (!["pending", "confirmed"].includes(r.status)) throw conflict(`A ${r.status.replace("_", " ")} reservation cannot be rescheduled`);
    const billed = await one(q, "select id from transactions where reservation_id = $1 limit 1", [id]);
    if (billed && Number(d.duration_hours) !== Number(r.duration_hours)) {
      throw conflict("This reservation is already billed, so its duration cannot change. Move it to another slot of the same length, or cancel and rebook");
    }
    const slot = await validateSlot(q, d, { excludeId: id });
    const quote = billed ? null : await quoteCourt(q, { ...d, player_id: r.player_id });
    await q.query(
      `update reservations set court_id = $2, start_at = $3, end_at = $4, duration_hours = $5, updated_by = $6,
          rate_type = coalesce($7, rate_type), rate_amount = coalesce($8::numeric, rate_amount),
          discount_amount = coalesce($9::numeric, discount_amount), total_amount = coalesce($10::numeric, total_amount)
       where id = $1`,
      [id, d.court_id, slot.start_at, slot.end_at, d.duration_hours, req.user.id, quote?.rate_type ?? null, quote?.rate_amount ?? null, quote?.discount_amount ?? null, quote?.total ?? null]
    );
    await audit(q, req, "reservation.reschedule", "reservation", id, { reference_no: r.reference_no, from: { court_id: r.court_id, start_at: r.start_at }, to: d });
    return getReservation(q, id);
  });
  res.json(row);
});

// server/routes/sales.ts
import { Router as Router7 } from "express";
import { z as z8 } from "zod";
var transactionsRouter = Router7();
transactionsRouter.post("/checkout", can("pos.use"), async (req, res) => {
  const input = parse(checkoutSchema, req.body);
  try {
    const result = await tx((q) => checkout(q, req.user, input, req.ip));
    res.status(input.preview ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof PreviewRollback) return void res.json(err.payload);
    if (err?.code === "23505" && String(err.constraint).includes("idempotency")) {
      const existing = await one(db, "select id from transactions where idempotency_key = $1", [input.idempotency_key]);
      if (existing) return void res.json({ ...await getTransaction(db, existing.id), replayed: true });
    }
    throw err;
  }
});
transactionsRouter.get("/", can("transactions.view"), async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, 5e3);
  const params = [];
  const where = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (str(req.query.from)) add(`manila_date(t.created_at) >= ?::date`, parse(zDate, req.query.from));
  if (str(req.query.to)) add(`manila_date(t.created_at) <= ?::date`, parse(zDate, req.query.to));
  if (str(req.query.cashier_id)) add(`t.cashier_id = ?`, parse(zId, req.query.cashier_id));
  if (str(req.query.status)) add(`t.status = ?`, req.query.status);
  if (str(req.query.type)) add(`t.transaction_type = ?`, req.query.type);
  if (str(req.query.shift_id)) add(`t.shift_id = ?`, parse(zId, req.query.shift_id));
  if (str(req.query.method)) add(`exists (select 1 from payments p where p.transaction_id = t.id and p.method = ?)`, req.query.method);
  if (str(req.query.q)) add(`(lower(t.transaction_no) like ? or lower(t.customer_name) like ?)`, `%${String(req.query.q).toLowerCase()}%`);
  if (!has(req.user, "shifts.view_all") && !has(req.user, "reports.view")) add(`t.cashier_id = ?`, req.user.id);
  const w = where.length ? "where " + where.join(" and ") : "";
  const [rows, total] = await Promise.all([
    db.query(
      `select t.*, e.full_name as cashier_name,
              coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '\u2014') as payment_methods
       from transactions t join employees e on e.id = t.cashier_id ${w} order by t.created_at desc limit ${limit} offset ${offset}`,
      params
    ),
    db.query(`select count(*)::int as n, coalesce(sum(t.total), 0) as total, coalesce(sum(t.amount_paid - t.refunded_total), 0) as collected from transactions t ${w}`, params)
  ]);
  res.json({ rows: rows.rows, page, limit, count: total.rows[0].n, total: total.rows[0].total, collected: total.rows[0].collected });
});
transactionsRouter.get("/:id", can("transactions.view", "pos.use"), async (req, res) => {
  const trx = await getTransaction(db, parse(zId, req.params.id));
  if (!has(req.user, "shifts.view_all") && !has(req.user, "reports.view") && trx.cashier_id !== req.user.id) throw forbidden();
  res.json(trx);
});
transactionsRouter.post("/:id/payments", can("pos.use"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const input = parse(addPaymentSchema, req.body);
  res.status(201).json(await tx((q) => addPayment(q, req.user, id, input, req.ip)));
});
transactionsRouter.post("/:id/refunds", can("refunds.request", "refunds.approve"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const input = parse(refundSchema, req.body);
  res.status(201).json(await tx((q) => refund(q, req.user, id, input, req.ip)));
});
transactionsRouter.post("/:id/reprint", can("transactions.view", "pos.use"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const trx = await getTransaction(db, id);
  await audit(db, req, "receipt.reprint", "transaction", id, { transaction_no: trx.transaction_no });
  res.json({ ok: true });
});
var shiftsRouter = Router7();
async function shiftSummary(q, shift) {
  const pay = await q.query(`select method, coalesce(sum(amount), 0) as amount, count(*)::int as count from payments where shift_id = $1 group by method order by method`, [shift.id]);
  const ref = await q.query(`select method, coalesce(sum(amount), 0) as amount, count(*)::int as count from refunds where shift_id = $1 group by method`, [shift.id]);
  const mv = await q.query(`select movement_type, coalesce(sum(amount), 0) as amount from cash_movements where shift_id = $1 group by movement_type`, [shift.id]);
  const trx = await one(q, `select count(*)::int as n, coalesce(sum(total), 0) as total from transactions where shift_id = $1`, [shift.id]);
  const of = (rows, key, val) => D(rows.find((r) => r[key] === val)?.amount ?? 0);
  const cashSales = of(pay.rows, "method", "cash");
  const nonCash = pay.rows.filter((r) => r.method !== "cash").reduce((a, r) => a.plus(r.amount), D(0));
  const cashRefunds = of(ref.rows, "method", "cash");
  const cashIn = of(mv.rows, "movement_type", "cash_in"), cashOut = of(mv.rows, "movement_type", "cash_out"), expenses = of(mv.rows, "movement_type", "expense");
  const expected = D(shift.opening_cash).plus(cashSales).minus(cashRefunds).plus(cashIn).minus(cashOut).minus(expenses);
  return {
    transactions: trx.n,
    sales_total: m(trx.total),
    opening_cash: m(shift.opening_cash),
    cash_sales: m(cashSales),
    non_cash_sales: m(nonCash),
    cash_refunds: m(cashRefunds),
    refunds_total: m(ref.rows.reduce((a, r) => a.plus(r.amount), D(0))),
    cash_in: m(cashIn),
    cash_out: m(cashOut),
    expenses: m(expenses),
    expected_cash: m(expected),
    by_method: pay.rows,
    refunds_by_method: ref.rows
  };
}
async function shiftDetail(q, id) {
  const shift = await one(q, `select s.*, e.full_name as cashier_name, c.full_name as closed_by_name from cashier_shifts s
                              join employees e on e.id = s.cashier_id left join employees c on c.id = s.closed_by where s.id = $1`, [id]);
  if (!shift) throw notFound("Shift");
  const movements = await q.query(`select cm.*, e.full_name as created_by_name from cash_movements cm join employees e on e.id = cm.created_by where cm.shift_id = $1 order by cm.created_at`, [id]);
  return { ...shift, summary: await shiftSummary(q, shift), movements: movements.rows };
}
shiftsRouter.get("/current", can("shifts.own"), async (req, res) => {
  const shift = await openShift(db, req.user.id);
  res.json(shift ? await shiftDetail(db, shift.id) : null);
});
shiftsRouter.get("/", can("shifts.own", "shifts.view_all"), async (req, res) => {
  const all2 = has(req.user, "shifts.view_all");
  const { rows } = await db.query(
    `select s.*, e.full_name as cashier_name,
            (select count(*)::int from transactions t where t.shift_id = s.id) as transactions,
            (select coalesce(sum(p.amount), 0) from payments p where p.shift_id = s.id) as collected
     from cashier_shifts s join employees e on e.id = s.cashier_id
     where ($1::uuid is null or s.cashier_id = $1) order by s.opened_at desc limit 300`,
    [all2 ? null : req.user.id]
  );
  res.json(rows);
});
shiftsRouter.get("/:id", can("shifts.own", "shifts.view_all"), async (req, res) => {
  const detail = await shiftDetail(db, parse(zId, req.params.id));
  if (!has(req.user, "shifts.view_all") && detail.cashier_id !== req.user.id) throw forbidden();
  res.json(detail);
});
shiftsRouter.post("/open", can("shifts.own"), async (req, res) => {
  const { opening_cash } = parse(z8.object({ opening_cash: zMoney }), req.body);
  const shift = await tx(async (q) => {
    if (await openShift(q, req.user.id)) throw conflict("You already have an open shift");
    const s = await one(q, "insert into cashier_shifts (shift_no, cashier_id, opening_cash) values ($1,$2,$3) returning *", [await numbers.shift(q), req.user.id, opening_cash]);
    await audit(q, req, "shift.open", "shift", s.id, { shift_no: s.shift_no, opening_cash });
    return s;
  });
  res.status(201).json(await shiftDetail(db, shift.id));
});
shiftsRouter.post("/movements", can("shifts.own"), async (req, res) => {
  const d = parse(z8.object({
    movement_type: z8.enum(["cash_in", "cash_out", "expense"]),
    amount: zMoney,
    reason: z8.string().trim().min(3).max(500),
    category_id: zId.optional()
    // required for expense
  }), req.body);
  if (!D(d.amount).gt(0)) throw badRequest("Amount must be greater than zero");
  await tx(async (q) => {
    const shift = await openShift(q, req.user.id);
    if (!shift) throw conflict("You have no open shift", "NO_SHIFT");
    let expenseId = null;
    if (d.movement_type === "expense") {
      if (!d.category_id) throw badRequest("Choose an expense category");
      expenseId = (await one(q, `insert into expenses (expense_no, category_id, description, amount, payment_method, shift_id, recorded_by)
                                 values ($1,$2,$3,$4,'cash',$5,$6) returning id`, [await numbers.expense(q), d.category_id, d.reason, d.amount, shift.id, req.user.id])).id;
    }
    const mv = await one(q, "insert into cash_movements (shift_id, movement_type, amount, reason, expense_id, created_by) values ($1,$2,$3,$4,$5,$6) returning id", [shift.id, d.movement_type, d.amount, d.reason, expenseId, req.user.id]);
    await audit(q, req, `shift.${d.movement_type}`, "shift", shift.id, { shift_no: shift.shift_no, amount: d.amount, reason: d.reason, movement_id: mv.id });
  });
  res.status(201).json({ ok: true });
});
shiftsRouter.post("/:id/close", can("shifts.own", "shifts.view_all"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(z8.object({ actual_cash: zMoney, notes: zOptText.optional() }), req.body);
  await tx(async (q) => {
    const shift = await one(q, "select * from cashier_shifts where id = $1 for update", [id]);
    if (!shift) throw notFound("Shift");
    if (shift.status !== "open") throw conflict("This shift is already closed");
    if (shift.cashier_id !== req.user.id && !has(req.user, "shifts.view_all")) throw forbidden("Only the cashier or a supervisor can close this shift");
    const s = await shiftSummary(q, shift);
    const variance = D(d.actual_cash).minus(s.expected_cash);
    await q.query(
      `update cashier_shifts set status = 'closed', closed_at = now(), closed_by = $2, expected_cash = $3, actual_cash = $4, variance = $5, notes = $6 where id = $1`,
      [id, req.user.id, s.expected_cash, d.actual_cash, m(variance), d.notes ?? null]
    );
    await audit(q, req, "shift.close", "shift", id, { shift_no: shift.shift_no, expected: s.expected_cash, actual: d.actual_cash, variance: m(variance) });
  });
  res.json(await shiftDetail(db, id));
});
var expensesRouter = Router7();
expensesRouter.get("/", can("expenses.view"), async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (str(req.query.from)) add("x.expense_date >= ?::date", parse(zDate, req.query.from));
  if (str(req.query.to)) add("x.expense_date <= ?::date", parse(zDate, req.query.to));
  if (str(req.query.status)) add("x.status = ?", req.query.status);
  if (str(req.query.category_id)) add("x.category_id = ?", parse(zId, req.query.category_id));
  const w = where.length ? "where " + where.join(" and ") : "";
  const [rows, byCategory] = await Promise.all([
    db.query(`select x.*, c.name as category_name, r.full_name as recorded_by_name, a.full_name as approved_by_name
              from expenses x join expense_categories c on c.id = x.category_id join employees r on r.id = x.recorded_by
              left join employees a on a.id = x.approved_by ${w} order by x.expense_date desc, x.created_at desc limit 2000`, params),
    db.query(`select c.name as category, coalesce(sum(x.amount) filter (where x.status = 'approved'), 0) as approved,
                     coalesce(sum(x.amount) filter (where x.status = 'pending'), 0) as pending
              from expenses x join expense_categories c on c.id = x.category_id ${w} group by c.name order by approved desc`, params)
  ]);
  res.json({ rows: rows.rows, by_category: byCategory.rows });
});
var expenseSchema = z8.object({
  expense_date: zDate,
  category_id: zId,
  description: z8.string().trim().min(2).max(500),
  amount: zMoney,
  payment_method: z8.enum(PAYMENT_METHODS).default("cash"),
  attachment_url: zOptText.optional()
});
expensesRouter.post("/", can("expenses.create", "expenses.approve"), async (req, res) => {
  const d = parse(expenseSchema, req.body);
  if (!D(d.amount).gt(0)) throw badRequest("Amount must be greater than zero");
  const row = await tx(async (q) => {
    const x = await one(q, `insert into expenses (expense_no, expense_date, category_id, description, amount, payment_method, attachment_url, recorded_by)
                            values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [await numbers.expense(q), d.expense_date, d.category_id, d.description, d.amount, d.payment_method, d.attachment_url ?? null, req.user.id]);
    await audit(q, req, "expense.create", "expense", x.id, { expense_no: x.expense_no, amount: d.amount, description: d.description });
    return x;
  });
  res.status(201).json(row);
});
expensesRouter.put("/:id", can("expenses.create", "expenses.approve"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const d = parse(expenseSchema, req.body);
  const row = await tx(async (q) => {
    const x = await one(q, "select * from expenses where id = $1 for update", [id]);
    if (!x) throw notFound("Expense");
    if (x.status !== "pending") throw conflict("Only pending expenses can be edited");
    if (x.shift_id) throw conflict("This expense was paid from a cashier drawer and cannot be edited");
    if (x.recorded_by !== req.user.id && !has(req.user, "expenses.approve")) throw forbidden();
    const after = await one(
      q,
      `update expenses set expense_date = $2, category_id = $3, description = $4, amount = $5, payment_method = $6, attachment_url = $7 where id = $1 returning *`,
      [id, d.expense_date, d.category_id, d.description, d.amount, d.payment_method, d.attachment_url ?? null]
    );
    await audit(q, req, "expense.update", "expense", id, { expense_no: x.expense_no, from: x.amount, to: d.amount });
    return after;
  });
  res.json(row);
});
expensesRouter.post("/:id/decision", can("expenses.approve"), async (req, res) => {
  const id = parse(zId, req.params.id);
  const { status } = parse(z8.object({ status: z8.enum(["approved", "rejected"]) }), req.body);
  const row = await tx(async (q) => {
    const x = await one(q, "select * from expenses where id = $1 for update", [id]);
    if (!x) throw notFound("Expense");
    if (x.status !== "pending") throw conflict(`This expense is already ${x.status}`);
    const after = await one(q, "update expenses set status = $2, approved_by = $3, approved_at = now() where id = $1 returning *", [id, status, req.user.id]);
    await audit(q, req, `expense.${status}`, "expense", id, { expense_no: x.expense_no, amount: x.amount });
    return after;
  });
  res.json(row);
});

// server/routes/system.ts
import crypto from "node:crypto";
import { Router as Router8 } from "express";
import multer from "multer";
import { z as z9 } from "zod";
var settingsRouter = Router8();
var settingsSchema = z9.object({
  business_name: z9.string().trim().min(1).max(120),
  business_address: z9.string().trim().max(300),
  business_contact: z9.string().trim().max(120),
  business_tin: z9.string().trim().max(60),
  receipt_footer: z9.string().trim().max(300),
  vat_registered: z9.boolean(),
  vat_rate: z9.coerce.number().min(0).max(50),
  sc_pwd_discount_rate: z9.coerce.number().min(0).max(100),
  sc_pwd_eligible_types: z9.array(z9.enum(["court", "product", "service", "equipment", "membership", "charge"])),
  member_discount_types: z9.array(z9.enum(["court", "product", "service", "equipment"])),
  require_open_shift: z9.boolean(),
  membership_expiry_notice_days: z9.coerce.number().int().min(0).max(90),
  booking_slot_minutes: z9.coerce.number().refine((v) => v === 30 || v === 60, "Must be 30 or 60"),
  max_advance_booking_days: z9.coerce.number().int().min(0).max(365),
  duration_months: z9.object({ monthly: z9.coerce.number().int().min(1), quarterly: z9.coerce.number().int().min(1), semi_annual: z9.coerce.number().int().min(1), annual: z9.coerce.number().int().min(1) })
}).partial();
settingsRouter.get("/", async (_req, res) => res.json(await getSettings(db)));
settingsRouter.put("/", can("settings.manage"), async (req, res) => {
  const d = parse(settingsSchema, req.body);
  await tx(async (q) => {
    const before = await getSettings(q);
    const changes = {};
    for (const [key, value] of Object.entries(d)) {
      if (value === void 0 || JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      await q.query(`insert into business_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
      changes[key] = { from: before[key], to: value };
    }
    if (Object.keys(changes).length) await audit(q, req, "settings.update", "settings", null, { changes });
  });
  res.json(await getSettings(db));
});
var auditRouter = Router8();
auditRouter.get("/", can("audit.view"), async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, 500);
  const params = [];
  const where = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (str(req.query.from)) add("manila_date(created_at) >= ?::date", parse(zDate, req.query.from));
  if (str(req.query.to)) add("manila_date(created_at) <= ?::date", parse(zDate, req.query.to));
  if (str(req.query.employee_id)) add("employee_id = ?", parse(zId, req.query.employee_id));
  if (str(req.query.action)) add("action like ?", `${req.query.action}%`);
  if (str(req.query.q)) add(`(lower(action) like ? or lower(coalesce(employee_name, '')) like ? or lower(details::text) like ?)`, `%${String(req.query.q).toLowerCase()}%`);
  const w = where.length ? "where " + where.join(" and ") : "";
  const rows = await db.query(`select * from audit_logs ${w} order by created_at desc limit ${limit} offset ${offset}`, params);
  const count = await one(db, `select count(*)::int as n from audit_logs ${w}`, params);
  const actions = await db.query(`select distinct split_part(action, '.', 1) as area from audit_logs order by 1`);
  res.json({ rows: rows.rows, count: count.n, page, limit, areas: actions.rows.map((r) => r.area) });
});
var notificationsRouter = Router8();
notificationsRouter.get("/", async (_req, res) => {
  const rows = await db.query("select * from notifications order by is_read, created_at desc limit 60");
  const unread = await one(db, "select count(*)::int as n from notifications where not is_read");
  res.json({ rows: rows.rows, unread: unread.n });
});
notificationsRouter.post("/read", async (req, res) => {
  const { id } = parse(z9.object({ id: zId.optional() }), req.body ?? {});
  await db.query("update notifications set is_read = true where not is_read and ($1::uuid is null or id = $1)", [id ?? null]);
  res.json({ ok: true });
});
async function runMaintenance(q = db) {
  await q.query(`update player_memberships set status = 'expired', status_reason = 'Term ended', status_changed_at = now()
                 where status = 'active' and end_date < manila_today()`);
  const days2 = (await getSettings(q)).membership_expiry_notice_days;
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'membership_expiring', 'Membership expiring soon',
            p.full_name || '''s ' || mp.name || ' expires on ' || to_char(pm.end_date, 'Mon DD, YYYY') || '. Offer a renewal.',
            'membership', pm.id, 'mem-exp-' || pm.id
     from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
     where pm.status = 'active' and pm.end_date between manila_today() and manila_today() + $1::int
     on conflict (dedupe_key) do nothing`,
    [days2]
  );
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'membership_expired', 'Membership expired', p.full_name || '''s ' || mp.name || ' expired on ' || to_char(pm.end_date, 'Mon DD, YYYY') || '.',
            'membership', pm.id, 'mem-expired-' || pm.id
     from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
     where pm.status = 'expired' and pm.end_date >= manila_today() - 14
     on conflict (dedupe_key) do nothing`
  );
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'low_stock', 'Low stock', name || ' is down to ' || stock_qty || ' (minimum ' || min_stock || ').', 'product', id,
            'low-stock-' || id || '-' || to_char(manila_today(), 'IYYY-IW')
     from products where status = 'active' and stock_qty <= min_stock
     on conflict (dedupe_key) do nothing`
  );
  await q.query(
    `insert into notifications (type, title, message, entity, entity_id, dedupe_key)
     select 'rental_overdue', 'Rental overdue', er.customer_name || ' has not returned ' || er.quantity || ' x ' || e.name || ' (' || er.rental_no || ').',
            'equipment_rental', er.id, 'rental-overdue-' || er.id
     from equipment_rentals er join equipment e on e.id = er.equipment_id
     where er.status = 'rented' and er.expected_return_at < now() - interval '15 minutes'
     on conflict (dedupe_key) do nothing`
  );
}
var uploadsRouter = Router8();
var ALLOWED = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ALLOWED[file.mimetype] ? cb(null, true) : cb(badRequest("Only JPG, PNG, WEBP or PDF files are allowed"))
});
uploadsRouter.post("/", can("players.manage", "inventory.manage", "expenses.create", "expenses.approve"), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("No file received");
  const name = crypto.randomBytes(16).toString("hex") + ALLOWED[req.file.mimetype];
  await tx(async (q) => {
    await q.query(
      "insert into uploaded_files (name, mime_type, size_bytes, data, uploaded_by) values ($1,$2,$3,$4,$5)",
      [name, req.file.mimetype, req.file.size, req.file.buffer, req.user?.id ?? null]
    );
    await audit(q, req, "file.upload", "file", null, { name, size: req.file.size, type: req.file.mimetype });
  });
  res.status(201).json({ url: `/uploads/${name}` });
});
uploadsRouter.get("/:name", async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(name)) throw badRequest("Invalid file name");
  const file = await one(db, "select mime_type, data from uploaded_files where name = $1", [name]);
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.set({ "Content-Type": file.mime_type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400" });
  res.send(file.data);
});

// server/app.ts
function createApp() {
  const app2 = express();
  app2.set("trust proxy", 1);
  app2.disable("x-powered-by");
  app2.use(helmet({
    contentSecurityPolicy: env.isProd ? { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:", "blob:"], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'", "data:"] } } : false
  }));
  app2.use(express.json({ limit: "1mb" }));
  app2.use(cookieParser());
  const api = express.Router();
  api.use((req, _res, next2) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "ekourt") {
      throw new HttpError(403, "Missing request header", "CSRF");
    }
    next2();
  });
  api.use((_req, res, next2) => {
    res.set("Cache-Control", "no-store");
    next2();
  });
  api.get("/health", async (_req, res) => {
    const r = await db.query(`select now() as now, current_database() as database, version() as version, to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') as manila_time`);
    res.json({ ok: true, ...r.rows[0] });
  });
  api.get("/public", async (_req, res) => {
    const r = await db.query(`select value from business_settings where key = 'business_name'`);
    res.json({ business_name: r.rows[0]?.value ?? "E-Kourt" });
  });
  api.use("/auth", authRouter);
  api.use(requireAuth);
  api.use(broadcastWrites);
  api.get("/events", eventsHandler);
  api.use("/employees", employeesRouter);
  api.use("/players", playersRouter);
  api.use("/courts", courtsRouter);
  api.use("/reservations", reservationsRouter);
  api.use("/products", productsRouter);
  api.use("/product-categories", categoriesRouter);
  api.use("/suppliers", suppliersRouter);
  api.use("/services", servicesRouter);
  api.use("/court-rates", ratesRouter);
  api.use("/holidays", holidaysRouter);
  api.use("/discounts", discountsRouter);
  api.use("/expense-categories", expenseCategoriesRouter);
  api.use("/membership-plans", plansRouter);
  api.use("/memberships", membershipsRouter);
  api.use("/equipment", equipmentRouter);
  api.use("/rentals", rentalsRouter);
  api.use("/inventory", inventoryRouter);
  api.use("/transactions", transactionsRouter);
  api.use("/shifts", shiftsRouter);
  api.use("/expenses", expensesRouter);
  api.use("/dashboard", dashboardRouter);
  api.use("/reports", reportsRouter);
  api.use("/settings", settingsRouter);
  api.use("/audit-logs", auditRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/uploads", uploadsRouter);
  api.use((_req, _res) => {
    throw new HttpError(404, "Unknown API route");
  });
  app2.use("/api", api);
  app2.use("/uploads", requireAuth, uploadsRouter);
  const dist = path2.join(rootDir, "dist");
  if (fs.existsSync(path2.join(dist, "index.html"))) {
    app2.use(express.static(dist, { index: false, maxAge: "1h" }));
    app2.use((req, res, next2) => req.method === "GET" ? res.sendFile(path2.join(dist, "index.html")) : next2());
  }
  app2.use(errorHandler);
  return app2;
}

// server/migrate.ts
import bcrypt3 from "bcryptjs";
import fs2 from "node:fs";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import pg2 from "pg";
async function migrate(log = console.log) {
  const client = new pg2.Client({ connectionString: env.databaseUrlDirect });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    await client.query("select pg_advisory_lock(727274)");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    const dir = path3.join(rootDir, "db", "migrations");
    for (const file of fs2.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      const sql = fs2.readFileSync(path3.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("COMMIT");
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    const { rows } = await client.query("select count(*)::int as n from employees");
    if (rows[0].n === 0) {
      if (!env.adminPassword) throw new Error("No employees exist and ADMIN_PASSWORD is not set. Run `npm run setup` first.");
      const hash = await bcrypt3.hash(env.adminPassword, 12);
      await client.query(
        `insert into employees (employee_no, full_name, email, password_hash, role, position)
         values ('EMP-0001', 'System Administrator', $1, $2, 'super_admin', 'Owner')`,
        [env.adminEmail.toLowerCase(), hash]
      );
      log(`[migrate] created Super Admin ${env.adminEmail} (password = ADMIN_PASSWORD in .env)`);
    }
    await client.query("select pg_advisory_unlock(727274)");
  } finally {
    await client.end();
  }
}
if (process.argv[1] && path3.resolve(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  assertEnv();
  migrate().then(() => console.log("[migrate] database is up to date")).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

// server/vercel.ts
var app = createApp();
var ready;
var lastMaintenance = 0;
async function init() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set in the Vercel project");
  if (env.jwtSecret.length < 32) throw new Error("JWT_SECRET is not set in the Vercel project (32+ characters)");
  await migrate();
}
async function handler(req, res) {
  try {
    await (ready ??= init());
  } catch (err) {
    ready = void 0;
    console.error("[api] startup failed:", err.message);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "The server is not configured correctly. Check the deployment logs." }));
    return;
  }
  if (Date.now() - lastMaintenance > 60 * 60 * 1e3) {
    lastMaintenance = Date.now();
    await runMaintenance().catch((e) => console.error("[maintenance]", e.message));
  }
  return app(req, res);
}
export {
  handler as default
};
