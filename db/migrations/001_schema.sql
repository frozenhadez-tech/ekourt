-- E-Kourt POS & Management System: core schema (PostgreSQL / Neon)
-- All money is numeric(12,2). All timestamps are timestamptz; business dates use Asia/Manila.

create extension if not exists btree_gist;

create or replace function manila_today() returns date language sql stable as
$$ select (now() at time zone 'Asia/Manila')::date $$;

create or replace function manila_date(ts timestamptz) returns date language sql immutable as
$$ select (ts at time zone 'Asia/Manila')::date $$;

create or replace function set_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

-- Gap-free, concurrency-safe document numbers (EKT-2026-000001 etc.)
create table number_sequences (
  name text not null,
  year int not null,
  last_value bigint not null default 0,
  primary key (name, year)
);

create or replace function next_number(p_name text, p_year int) returns bigint language sql as
$$
  insert into number_sequences (name, year, last_value) values (p_name, p_year, 1)
  on conflict (name, year) do update set last_value = number_sequences.last_value + 1
  returning last_value
$$;

create table business_settings (
  key text primary key,
  value jsonb not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Employees double as login accounts (custom auth; replaces Supabase profiles).
create table employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text not null unique,
  full_name text not null,
  email text not null,
  password_hash text not null,
  role text not null check (role in ('super_admin','admin','manager','cashier','receptionist')),
  contact_number text,
  position text,
  hire_date date,
  is_active boolean not null default true,
  token_version int not null default 0,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index employees_email_key on employees (lower(email));

create table players (
  id uuid primary key default gen_random_uuid(),
  player_no text not null unique,
  full_name text not null,
  gender text check (gender in ('male','female','other')),
  birthday date,
  contact_number text,
  email text,
  address text,
  emergency_contact_name text,
  emergency_contact_number text,
  registration_date date not null default manila_today(),
  status text not null default 'active' check (status in ('active','inactive','banned')),
  photo_url text,
  notes text,
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index players_email_key on players (lower(email)) where email is not null and email <> '';
create unique index players_contact_key on players (contact_number) where contact_number is not null and contact_number <> '';
create index players_name_idx on players (lower(full_name));

create table courts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  court_type text not null default 'indoor' check (court_type in ('indoor','outdoor','covered')),
  hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0),
  status text not null default 'available' check (status in ('available','maintenance','closed')),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table court_operating_hours (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references courts(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6), -- 0 = Sunday
  open_time time not null default '06:00',
  close_time time not null default '22:00',
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (court_id, day_of_week),
  check (close_time > open_time)
);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Configurable court rental price list. Nothing in the application hardcodes a price.
create table court_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rate_type text not null check (rate_type in ('weekday','weekend','holiday','peak','off_peak','promo')),
  duration_hours numeric(4,1) not null check (duration_hours > 0),
  price numeric(12,2) not null check (price >= 0),
  day_scope text not null default 'all' check (day_scope in ('all','weekday','weekend')),
  start_time time,           -- time window (peak / off-peak / promo)
  end_time time,
  valid_from date,           -- date window (promo)
  valid_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index court_rates_type_idx on court_rates (rate_type) where is_active;

create table membership_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  monthly_price numeric(12,2) not null check (monthly_price >= 0),
  court_discount_percent numeric(5,2) not null default 0 check (court_discount_percent between 0 and 100),
  free_paddle_rentals_per_month int not null default 0 check (free_paddle_rentals_per_month >= 0),
  priority_booking boolean not null default false,
  advance_booking_days int not null default 7 check (advance_booking_days >= 0),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table membership_benefits (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references membership_plans(id) on delete cascade,
  description text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index membership_benefits_plan_idx on membership_benefits (plan_id);

create table product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_person text,
  contact_number text,
  email text,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category_id uuid references product_categories(id),
  description text,
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),
  selling_price numeric(12,2) not null check (selling_price >= 0),
  stock_qty int not null default 0 check (stock_qty >= 0),
  min_stock int not null default 0 check (min_stock >= 0),
  supplier_id uuid references suppliers(id),
  image_url text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on products (category_id);

create table services (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  category text not null default 'general',
  charge_method text not null default 'fixed' check (charge_method in ('per_hour','per_person','per_session','per_item','fixed')),
  price numeric(12,2) not null check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table equipment (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  rental_rate numeric(12,2) not null check (rental_rate >= 0),
  charge_method text not null default 'per_session' check (charge_method in ('per_hour','per_session','per_use')),
  total_qty int not null default 0 check (total_qty >= 0),
  available_qty int not null default 0 check (available_qty >= 0),
  damaged_qty int not null default 0 check (damaged_qty >= 0),
  missing_qty int not null default 0 check (missing_qty >= 0),
  entitlement_type text,     -- e.g. 'free_paddle_rental' links to membership entitlements
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (available_qty <= total_qty)
);

create table discounts (
  id uuid primary key default gen_random_uuid(),
  code text,
  name text not null,
  discount_type text not null check (discount_type in ('percentage','fixed','promo','senior','pwd','special_event')),
  value_type text not null default 'percent' check (value_type in ('percent','fixed')),
  value numeric(12,2) not null default 0 check (value >= 0),
  applies_to text[] not null default '{}',   -- item types; empty = every item type
  min_amount numeric(12,2) not null default 0,
  valid_from date,
  valid_to date,
  usage_limit int,
  usage_count int not null default 0,
  requires_approval boolean not null default false,
  stackable_with_membership boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (value_type <> 'percent' or value <= 100)
);
create unique index discounts_code_key on discounts (upper(code)) where code is not null and code <> '';

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cashier_shifts (
  id uuid primary key default gen_random_uuid(),
  shift_no text not null unique,
  cashier_id uuid not null references employees(id),
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  opening_cash numeric(12,2) not null default 0 check (opening_cash >= 0),
  closed_at timestamptz,
  closed_by uuid references employees(id),
  expected_cash numeric(12,2),
  actual_cash numeric(12,2),
  variance numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cashier_shifts_one_open on cashier_shifts (cashier_id) where status = 'open';

create table reservations (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  player_id uuid references players(id),
  customer_name text not null,
  customer_contact text,
  court_id uuid not null references courts(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_hours numeric(4,1) not null check (duration_hours > 0),
  status text not null default 'pending'
    check (status in ('pending','confirmed','checked_in','in_progress','completed','cancelled','no_show')),
  is_walk_in boolean not null default false,
  rate_type text,
  rate_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  notes text,
  cancel_reason text,
  checked_in_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references employees(id),
  updated_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  -- Database-level double-booking guard: no two live reservations may overlap on one court.
  constraint reservations_no_overlap exclude using gist (
    court_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('pending','confirmed','checked_in','in_progress'))
);
create index reservations_start_idx on reservations (start_at);
create index reservations_player_idx on reservations (player_id);
create index reservations_status_idx on reservations (status);

create table reservation_players (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  player_id uuid not null references players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reservation_id, player_id)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_no text not null unique,
  transaction_type text not null,
  player_id uuid references players(id),
  customer_name text not null default 'Walk-in Customer',
  reservation_id uuid references reservations(id),
  shift_id uuid references cashier_shifts(id),
  cashier_id uuid not null references employees(id),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  discount_total numeric(12,2) not null default 0 check (discount_total >= 0),
  total numeric(12,2) not null check (total >= 0),
  vatable_sales numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  vat_exempt_sales numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  change_due numeric(12,2) not null default 0,
  refunded_total numeric(12,2) not null default 0,
  status text not null check (status in ('completed','partial','refunded','partially_refunded')),
  discount_id uuid references discounts(id),
  discount_label text,
  discount_id_number text,   -- Senior Citizen / PWD ID presented
  approved_by uuid references employees(id),
  idempotency_key text not null unique,   -- duplicate-submission guard
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_created_idx on transactions (created_at desc);
create index transactions_player_idx on transactions (player_id);
create index transactions_cashier_idx on transactions (cashier_id);
create index transactions_shift_idx on transactions (shift_id);
create index transactions_reservation_idx on transactions (reservation_id);

create table transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  item_type text not null check (item_type in ('court','product','service','equipment','membership','charge')),
  ref_id uuid,
  description text not null,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),   -- price snapshot at time of sale
  discount_amount numeric(12,2) not null default 0,
  line_total numeric(12,2) not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transaction_items_tx_idx on transaction_items (transaction_id);
create index transaction_items_ref_idx on transaction_items (item_type, ref_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  reservation_id uuid references reservations(id),
  shift_id uuid references cashier_shifts(id),
  kind text not null default 'payment' check (kind in ('payment','deposit','balance')),
  method text not null check (method in ('cash','gcash','maya','bank_transfer','credit_card','debit_card')),
  amount numeric(12,2) not null check (amount > 0),      -- amount applied to the bill
  tendered numeric(12,2) not null check (tendered > 0),  -- amount handed over (cash may exceed)
  reference_no text,
  idempotency_key text unique,
  received_by uuid not null references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_tx_idx on payments (transaction_id);
create index payments_shift_idx on payments (shift_id);
create index payments_created_idx on payments (created_at);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  refund_no text not null unique,
  transaction_id uuid not null references transactions(id),
  shift_id uuid references cashier_shifts(id),
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('cash','gcash','maya','bank_transfer','credit_card','debit_card')),
  reason text not null,
  restocked boolean not null default false,
  requested_by uuid not null references employees(id),
  approved_by uuid not null references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refunds_tx_idx on refunds (transaction_id);
create index refunds_created_idx on refunds (created_at);

create table player_memberships (
  id uuid primary key default gen_random_uuid(),
  membership_no text not null unique,
  player_id uuid not null references players(id),
  plan_id uuid not null references membership_plans(id),
  duration text not null check (duration in ('monthly','quarterly','semi_annual','annual')),
  action text not null default 'new' check (action in ('new','renewal','upgrade','downgrade')),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active','suspended','cancelled','expired','replaced')),
  price_paid numeric(12,2) not null default 0,
  transaction_id uuid references transactions(id),
  previous_membership_id uuid references player_memberships(id),
  status_reason text,
  status_changed_at timestamptz,
  status_changed_by uuid references employees(id),
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
-- A player holds at most one live (active or suspended) membership at a time.
create unique index player_memberships_one_live on player_memberships (player_id) where status in ('active','suspended');
create index player_memberships_end_idx on player_memberships (end_date);

create table membership_entitlements (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references player_memberships(id),
  entitlement_type text not null,
  period_start date not null,     -- first day of the calendar month the allowance belongs to
  quantity_total int not null check (quantity_total >= 0),
  quantity_used int not null default 0 check (quantity_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (membership_id, entitlement_type, period_start),
  check (quantity_used <= quantity_total)
);

create table discount_usage (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('discount','membership')),
  discount_id uuid references discounts(id),
  membership_id uuid references player_memberships(id),
  transaction_id uuid not null references transactions(id),
  player_id uuid references players(id),
  amount numeric(12,2) not null,
  approved_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index discount_usage_tx_idx on discount_usage (transaction_id);

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  movement_type text not null check (movement_type in ('stock_in','stock_out','adjustment','sale','refund')),
  quantity int not null,          -- signed: positive adds stock, negative removes
  balance_after int not null,
  unit_cost numeric(12,2),
  transaction_id uuid references transactions(id),
  notes text,
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_movements_product_idx on inventory_movements (product_id, created_at desc);

create table equipment_rentals (
  id uuid primary key default gen_random_uuid(),
  rental_no text not null unique,
  equipment_id uuid not null references equipment(id),
  player_id uuid references players(id),
  customer_name text not null,
  quantity int not null check (quantity > 0),
  rented_at timestamptz not null default now(),
  expected_return_at timestamptz,
  returned_at timestamptz,
  status text not null default 'rented' check (status in ('rented','returned','returned_with_issues')),
  qty_returned int not null default 0,
  qty_damaged int not null default 0,
  qty_missing int not null default 0,
  charge numeric(12,2) not null default 0,
  is_free_entitlement boolean not null default false,
  transaction_id uuid references transactions(id),
  issued_by uuid references employees(id),
  received_by uuid references employees(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index equipment_rentals_status_idx on equipment_rentals (status);
create index equipment_rentals_player_idx on equipment_rentals (player_id);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  expense_no text not null unique,
  expense_date date not null default manila_today(),
  category_id uuid not null references expense_categories(id),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','gcash','maya','bank_transfer','credit_card','debit_card')),
  attachment_url text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  shift_id uuid references cashier_shifts(id),
  recorded_by uuid not null references employees(id),
  approved_by uuid references employees(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index expenses_date_idx on expenses (expense_date);

create table cash_movements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references cashier_shifts(id),
  movement_type text not null check (movement_type in ('cash_in','cash_out','expense')),
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,
  expense_id uuid references expenses(id),
  created_by uuid not null references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cash_movements_shift_idx on cash_movements (shift_id);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  message text not null,
  entity text,
  entity_id uuid,
  dedupe_key text unique,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notifications_unread_idx on notifications (created_at desc) where not is_read;

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id),
  employee_name text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}',
  ip_address text,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_action_idx on audit_logs (action);
