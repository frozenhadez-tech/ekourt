# E-Kourt POS & Management System

Point of sale and facility management for a pickleball court business in the Philippines:
reservations, cashiering, memberships, equipment rental, inventory, expenses, reports, role-based access and audit logging.
Currency is Philippine Peso (₱); all business dates and times use `Asia/Manila`.

## Architecture

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, shadcn-style components (Radix), Lucide, Recharts, TanStack Query, Day.js |
| API | Node.js, Express 5, Zod validation, `decimal.js` for money |
| Database | PostgreSQL on **Neon**, accessed with `pg` (node-postgres) over a pooled connection |
| Auth | Own login: bcrypt password hashes, signed JWT in an `HttpOnly`, `SameSite=Strict` cookie |
| Live updates | Server-Sent Events: every successful write refreshes open screens |

> The original specification named Supabase. This build targets Neon instead, which is plain PostgreSQL with no
> built-in auth, REST layer, realtime or row-level-security roles. Those are provided by the Express API:
> **every permission is checked on the server**, and financial integrity is additionally enforced by database
> constraints and triggers. The browser never talks to the database and never holds a database credential.

```
db/migrations/   SQL schema, triggers, seed data (applied automatically, in order, once)
server/          Express API
  services/      pricing, reservations, checkout / payments / refunds (all transactional)
  routes/        REST endpoints per module
shared/          roles and permissions, shared by API and UI
src/             React app (pages/, components/, lib/)
tests/           end-to-end API workflow test
neon.ts          Neon project configuration (used by `neon deploy`)
```

## Setup

Requirements: Node.js 20 or newer, a Neon project.

```bash
npm install
npm run setup          # writes JWT_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD to .env (git-ignored)
neon login             # once per machine
neon deploy            # applies neon.ts and pulls DATABASE_URL into .env
npm run dev            # API on :4000, web on http://localhost:5173
```

Without the Neon CLI, copy `.env.example` to `.env` and paste your Neon connection strings.

On first start the API applies the migrations in `db/migrations` and, if there are no employees yet, creates one
Super Admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`. Sign in with those and change the password
(sidebar → Password), then add your staff under Employee Management.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API (watch mode) and Vite dev server together |
| `npm run build` | Type-check everything, then build the web app into `dist/` |
| `npm start` | Production: one server serves the API and the built web app on `PORT` |
| `npm run db:migrate` | Apply pending migrations without starting the server |
| `npm run test:api` | End-to-end workflow test (see below) |
| `npm run test:smoke` | Read-only check of a running server: database, login, every module's list endpoint. Safe on production |

### Production deployment

**Vercel** (how https://ekourt.vercel.app is hosted): `vercel.json` serves the built web app as static files and
sends `/api/*` and `/uploads/*` to one serverless function, `api/index.js`, which `npm run build` bundles from
`server/vercel.ts`. Set `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `JWT_SECRET` in the Vercel project, then
`vercel deploy --prod`. Pending migrations apply on the function's first request. On Vercel, screens refresh on a
20-second poll instead of instantly, and the login throttle counts per function instance.

**Any Node host** (a VM, Render, Railway, Fly.io): run `npm run build`, then `npm start` with `NODE_ENV=production`
and the same three variables. Serve it over HTTPS: the session cookie is marked `Secure` in production. Live updates
are instant but in-process; with more than one instance, screens on other instances fall back to polling.

Uploaded files (player photos, receipts; 4 MB limit) are stored in the database table `uploaded_files`, so no host
needs a persistent disk.

## Testing

`npm run test:api` boots the real API against the database in `DATABASE_URL` and drives the complete flows over HTTP:
login and permissions, player registration, pricing, booking conflicts (including 10 simultaneous requests for one slot),
POS checkout, duplicate-submission protection, stock races, deposits and balances, memberships and discounts,
Senior Citizen VAT maths, rentals, authorised refunds, shift reconciliation, reports and the audit log.

Because completed transactions can never be deleted, run it on a Neon **development branch**, not production:

```bash
neon checkout dev --create     # also pulls the dev branch's env into .env
# PowerShell:  $env:ALLOW_TEST_ON_THIS_DB = "1"; npm run test:api
ALLOW_TEST_ON_THIS_DB=1 npm run test:api
neon checkout production       # switches .env back to production
```

## Roles

Defined in `shared/permissions.ts` and enforced by the API on every request.

| Role | Access |
| --- | --- |
| Super Admin | Everything, including employees, system settings and pricing |
| Admin | Operations, players, reservations, memberships, inventory, discounts, expenses, reports, approvals |
| Manager | Reports, dashboards, approve refunds / restricted discounts / expenses, view shifts and audit log |
| Cashier | POS, payments, receipts, own shift, player registration, reservations, rental returns |
| Receptionist | Player registration, court availability, reservations, check-in and check-out |

A cashier can only refund, or apply a discount marked "requires approval", when a manager enters their own
credentials at the till; the approver is stored on the record.

## How the business rules are enforced

| Rule | Where |
| --- | --- |
| No overlapping bookings | PostgreSQL `EXCLUDE` constraint on `(court_id, tstzrange(start_at, end_at))` for live statuses, plus a row lock on the court during booking |
| Unique numbers (`EK-`, `EKB-`, `EKT-`, …) | `next_number()` counter table, incremented inside the same transaction |
| Prices are configurable, history is fixed | Prices live in tables; each `transaction_items` row stores the unit price charged |
| No edits or deletes of financial records | Triggers reject `UPDATE`/`DELETE` on items, payments, refunds, stock movements and audit logs; transactions allow only settlement fields to change |
| Duplicate submissions | Unique `idempotency_key` on transactions and balance payments |
| Stock and rental units | Conditional atomic `UPDATE … WHERE stock_qty >= n`; `CHECK (stock_qty >= 0)` |
| Exact money | `numeric(12,2)` in the database, `decimal.js` in the API; the UI only displays server results |
| Member discounts | Applied only when the membership is `active` and today is inside its date range, and only to item types listed in Settings |
| One discount per sale | A promo / Senior / PWD discount never stacks on the member discount unless the discount is marked stackable; otherwise the larger one applies |

## Assumptions and defaults (all configurable unless noted)

- **VAT** is off by default (`Settings → Tax`). Selling prices are treated as VAT-inclusive.
- **Senior Citizen / PWD discount**: applied only when the cashier selects it and enters the ID number. Rate 20%.
  Non-VAT business: 20% of the price. VAT-registered: VAT is removed first, then 20% off the VAT-exclusive price,
  and the sale is recorded as VAT-exempt. Eligible item types are set in Settings (default: court, services, rentals).
  Have your accountant confirm the configuration for your BIR registration.
- **Court pricing precedence**: Promo → Holiday → Peak → Off-peak → Weekend/Weekday. A duration with no exact
  package uses the cheapest combination of packages (4 hours on a weekday = 800 + 300). Half Day = 6 h, Whole Day = 12 h.
- **Membership price** = monthly price × months (3 / 6 / 12). A renewal extends from the day after the current term;
  an upgrade or downgrade starts a new term today with no proration.
- **Free paddle rentals** reset each calendar month.
- **One court booking per transaction**; a customer can hold any number of bookings.
- **Rescheduling** an already-paid booking keeps its duration and the price charged.
- **Cancelling** a paid booking does not return money by itself; refund it from the transaction with approval.
- **Revenue** in the dashboard and reports is cash-basis: payments received minus refunds paid, by Manila date.
  Net income = that revenue minus *approved* expenses.

## Not included

- Online payment gateway integration: GCash, Maya, bank and card payments are recorded with a reference number,
  not charged through an API.
- BIR-accredited official receipts / CAS registration: the printed receipt is an internal sales record.
- SMS or email delivery of renewal notices: notices appear in the in-app notification bell.
- Late-return rental fees and a self-service customer booking site.
