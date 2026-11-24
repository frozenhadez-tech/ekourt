// Dashboard and reports. Every figure is computed from live database rows.
// "Revenue" is cash-basis: payments received minus refunds paid, by Asia/Manila business date.
import { Router } from 'express';
import { can, has } from '../auth';
import { db, one } from '../db';
import { notFound, parse, zDate } from '../http';
import { D, m } from '../money';
import { RESERVATION_SELECT } from '../services/reservations';

export const dashboardRouter = Router();

dashboardRouter.get('/', can('dashboard.view'), async (req, res) => {
  const fin = has(req.user!, 'dashboard.financials');
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
  else for (const k of ['today_revenue', 'month_revenue', 'month_expenses']) delete stats[k];

  const q = (sql: string, params: unknown[] = []) => db.query(sql, params).then((r) => r.rows);
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
    has(req.user!, 'transactions.view')
      ? q(`select t.id, t.transaction_no, t.customer_name, t.created_at, t.transaction_type, t.total, t.status, e.full_name as cashier_name,
                  coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '—') as payment_methods
           from transactions t join employees e on e.id = t.cashier_id
           ${has(req.user!, 'shifts.view_all') || has(req.user!, 'reports.view') ? '' : 'where t.cashier_id = $1'} order by t.created_at desc limit 8`,
          has(req.user!, 'shifts.view_all') || has(req.user!, 'reports.view') ? [] : [req.user!.id])
      : [],
  ]);
  res.json({ stats, financials: fin, reservation_stats: reservationStats, top_courts: topCourts, top_products: topProducts,
    membership_distribution: memberDist, today_reservations: todayReservations, daily_revenue: daily, monthly_revenue: monthly,
    payment_methods: methods, recent_transactions: recent });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
type Col = { key: string; label: string; type?: 'money' | 'number' | 'date' | 'datetime' | 'text' };
interface Report { title: string; group: 'Daily' | 'Monthly' | 'Business'; columns: Col[]; sql: string; chart?: { x: string; y: string }; noDates?: boolean }

const c = (key: string, label: string, type: Col['type'] = 'text'): Col => ({ key, label, type });
const days = `generate_series($1::date, $2::date, interval '1 day') g(d)`;
const months = `generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') g(mth)`;
const inRange = (col: string) => `manila_date(${col}) between $1::date and $2::date`;

const REPORTS: Record<string, Report> = {
  daily_sales: {
    title: 'Daily Sales', group: 'Daily', chart: { x: 'date', y: 'net_revenue' },
    columns: [c('date', 'Date', 'date'), c('transactions', 'Transactions', 'number'), c('gross_sales', 'Billed', 'money'), c('discounts', 'Discounts', 'money'), c('collected', 'Collected', 'money'), c('refunds', 'Refunds', 'money'), c('net_revenue', 'Net Revenue', 'money')],
    sql: `select to_char(d, 'YYYY-MM-DD') as date,
            (select count(*)::int from transactions where manila_date(created_at) = d) as transactions,
            (select coalesce(sum(total), 0) from transactions where manila_date(created_at) = d) as gross_sales,
            (select coalesce(sum(discount_total), 0) from transactions where manila_date(created_at) = d) as discounts,
            (select coalesce(sum(amount), 0) from payments where manila_date(created_at) = d) as collected,
            (select coalesce(sum(amount), 0) from refunds where manila_date(created_at) = d) as refunds,
            (select coalesce(sum(amount), 0) from payments where manila_date(created_at) = d) - (select coalesce(sum(amount), 0) from refunds where manila_date(created_at) = d) as net_revenue
          from ${days} order by d`,
  },
  daily_reservations: {
    title: 'Daily Reservations', group: 'Daily', chart: { x: 'date', y: 'total' },
    columns: [c('date', 'Date', 'date'), c('total', 'Bookings', 'number'), c('completed', 'Completed', 'number'), c('cancelled', 'Cancelled', 'number'), c('no_show', 'No Show', 'number'), c('hours', 'Hours Booked', 'number'), c('value', 'Booking Value', 'money')],
    sql: `select to_char(d, 'YYYY-MM-DD') as date, count(r.id)::int as total,
            count(r.id) filter (where r.status = 'completed')::int as completed, count(r.id) filter (where r.status = 'cancelled')::int as cancelled,
            count(r.id) filter (where r.status = 'no_show')::int as no_show,
            coalesce(sum(r.duration_hours) filter (where r.status not in ('cancelled','no_show')), 0)::float as hours,
            coalesce(sum(r.total_amount) filter (where r.status not in ('cancelled','no_show')), 0) as value
          from ${days} left join reservations r on manila_date(r.start_at) = d group by d order by d`,
  },
  daily_transactions: {
    title: 'Transaction Listing', group: 'Daily',
    columns: [c('transaction_no', 'Transaction No.'), c('created_at', 'Date', 'datetime'), c('customer_name', 'Customer'), c('transaction_type', 'Type'), c('cashier', 'Cashier'), c('methods', 'Payment'), c('total', 'Total', 'money'), c('amount_paid', 'Paid', 'money'), c('balance', 'Balance', 'money'), c('status', 'Status')],
    sql: `select t.transaction_no, t.created_at, t.customer_name, t.transaction_type, e.full_name as cashier, t.total, t.amount_paid, t.balance, t.status,
            coalesce((select string_agg(distinct p.method, ', ') from payments p where p.transaction_id = t.id), '') as methods
          from transactions t join employees e on e.id = t.cashier_id where ${inRange('t.created_at')} order by t.created_at`,
  },
  daily_expenses: {
    title: 'Expenses', group: 'Daily',
    columns: [c('expense_no', 'Expense No.'), c('expense_date', 'Date', 'date'), c('category', 'Category'), c('description', 'Description'), c('payment_method', 'Method'), c('recorded_by', 'Recorded By'), c('status', 'Status'), c('amount', 'Amount', 'money')],
    sql: `select x.expense_no, x.expense_date, ec.name as category, x.description, x.payment_method, e.full_name as recorded_by, x.status, x.amount
          from expenses x join expense_categories ec on ec.id = x.category_id join employees e on e.id = x.recorded_by
          where x.expense_date between $1::date and $2::date order by x.expense_date, x.created_at`,
  },
  cashier_summary: {
    title: 'Cashier Shift Summary', group: 'Daily',
    columns: [c('shift_no', 'Shift'), c('cashier', 'Cashier'), c('opened_at', 'Opened', 'datetime'), c('closed_at', 'Closed', 'datetime'), c('transactions', 'Transactions', 'number'), c('opening_cash', 'Opening Cash', 'money'), c('cash_sales', 'Cash Sales', 'money'), c('non_cash', 'Non-cash', 'money'), c('expected_cash', 'Expected Cash', 'money'), c('actual_cash', 'Actual Cash', 'money'), c('variance', 'Over / (Short)', 'money')],
    sql: `select s.shift_no, e.full_name as cashier, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash, s.actual_cash, s.variance,
            (select count(*)::int from transactions t where t.shift_id = s.id) as transactions,
            (select coalesce(sum(amount), 0) from payments p where p.shift_id = s.id and p.method = 'cash') as cash_sales,
            (select coalesce(sum(amount), 0) from payments p where p.shift_id = s.id and p.method <> 'cash') as non_cash
          from cashier_shifts s join employees e on e.id = s.cashier_id where ${inRange('s.opened_at')} order by s.opened_at`,
  },
  court_utilization: {
    title: 'Court Utilization', group: 'Daily', chart: { x: 'court', y: 'utilization_pct' },
    columns: [c('court', 'Court'), c('bookings', 'Bookings', 'number'), c('hours_booked', 'Hours Booked', 'number'), c('hours_open', 'Hours Open', 'number'), c('utilization_pct', 'Utilization %', 'number'), c('revenue', 'Booking Value', 'money')],
    sql: `select c.name as court,
            (select count(*)::int from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange('r.start_at')}) as bookings,
            (select coalesce(sum(r.duration_hours), 0)::float from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange('r.start_at')}) as hours_booked,
            oh.hours_open,
            case when oh.hours_open > 0 then round(100 * (select coalesce(sum(r.duration_hours), 0) from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange('r.start_at')}) / oh.hours_open::numeric, 1)::float else 0 end as utilization_pct,
            (select coalesce(sum(r.total_amount), 0) from reservations r where r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange('r.start_at')}) as revenue
          from courts c cross join lateral (
            select coalesce(sum(extract(epoch from (h.close_time - h.open_time)) / 3600), 0)::float as hours_open
            from ${days} join court_operating_hours h on h.court_id = c.id and h.day_of_week = extract(dow from d)::int and not h.is_closed) oh
          where c.is_active order by c.sort_order`,
  },
  monthly_summary: {
    title: 'Monthly Revenue, Expenses & Net Income', group: 'Monthly', chart: { x: 'month', y: 'net_income' },
    columns: [c('month', 'Month'), c('collected', 'Collected', 'money'), c('refunds', 'Refunds', 'money'), c('revenue', 'Net Revenue', 'money'), c('expenses', 'Expenses', 'money'), c('net_income', 'Est. Net Operating Income', 'money')],
    sql: `select month, collected, refunds, collected - refunds as revenue, expenses, collected - refunds - expenses as net_income from (
            select to_char(mth, 'YYYY-MM') as month,
              (select coalesce(sum(amount), 0) from payments where date_trunc('month', manila_date(created_at)) = mth) as collected,
              (select coalesce(sum(amount), 0) from refunds where date_trunc('month', manila_date(created_at)) = mth) as refunds,
              (select coalesce(sum(amount), 0) from expenses where status = 'approved' and date_trunc('month', expense_date) = mth) as expenses
            from ${months}) x order by month`,
  },
  revenue_by_category: {
    title: 'Revenue by Category (Court, Membership, Product, Service)', group: 'Monthly', chart: { x: 'category', y: 'net_sales' },
    columns: [c('category', 'Category'), c('items', 'Lines', 'number'), c('quantity', 'Quantity', 'number'), c('gross', 'Gross', 'money'), c('discounts', 'Discounts', 'money'), c('net_sales', 'Net Sales', 'money')],
    sql: `select case ti.item_type when 'court' then 'Court Rental' when 'membership' then 'Membership Sales' when 'product' then 'Product Sales'
                   when 'service' then 'Service Revenue' when 'equipment' then 'Equipment Rental' else 'Other Charges' end as category,
            count(*)::int as items, sum(ti.quantity)::float as quantity, sum(ti.unit_price * ti.quantity) as gross, sum(ti.discount_amount) as discounts, sum(ti.line_total) as net_sales
          from transaction_items ti join transactions t on t.id = ti.transaction_id
          where ${inRange('t.created_at')} and t.status <> 'refunded' group by 1 order by net_sales desc`,
  },
  product_sales: {
    title: 'Product Sales', group: 'Monthly', chart: { x: 'product', y: 'net_sales' },
    columns: [c('product', 'Product'), c('quantity', 'Qty Sold', 'number'), c('net_sales', 'Net Sales', 'money'), c('cost', 'Est. Cost', 'money'), c('margin', 'Est. Margin', 'money')],
    sql: `select ti.description as product, sum(ti.quantity)::float as quantity, sum(ti.line_total) as net_sales,
            sum(ti.quantity * coalesce(p.cost_price, 0)) as cost, sum(ti.line_total) - sum(ti.quantity * coalesce(p.cost_price, 0)) as margin
          from transaction_items ti join transactions t on t.id = ti.transaction_id left join products p on p.id = ti.ref_id
          where ti.item_type = 'product' and ${inRange('t.created_at')} and t.status <> 'refunded' group by ti.description order by net_sales desc`,
  },
  service_revenue: {
    title: 'Service Revenue', group: 'Monthly', chart: { x: 'service', y: 'net_sales' },
    columns: [c('service', 'Service'), c('quantity', 'Quantity', 'number'), c('net_sales', 'Net Sales', 'money')],
    sql: `select ti.description as service, sum(ti.quantity)::float as quantity, sum(ti.line_total) as net_sales
          from transaction_items ti join transactions t on t.id = ti.transaction_id
          where ti.item_type in ('service','charge') and ${inRange('t.created_at')} and t.status <> 'refunded' group by ti.description order by net_sales desc`,
  },
  membership_sales: {
    title: 'Membership Sales', group: 'Monthly',
    columns: [c('membership_no', 'Membership No.'), c('created_at', 'Sold', 'datetime'), c('player', 'Player'), c('plan', 'Plan'), c('duration', 'Duration'), c('action', 'Type'), c('start_date', 'Start', 'date'), c('end_date', 'End', 'date'), c('price_paid', 'Amount', 'money')],
    sql: `select pm.membership_no, pm.created_at, p.full_name as player, mp.name as plan, pm.duration, pm.action, pm.start_date, pm.end_date, pm.price_paid
          from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
          where ${inRange('pm.created_at')} order by pm.created_at`,
  },
  payment_methods: {
    title: 'Payment Method Summary', group: 'Monthly', chart: { x: 'method', y: 'net' },
    columns: [c('method', 'Method'), c('payments', 'Payments', 'number'), c('collected', 'Collected', 'money'), c('refunded', 'Refunded', 'money'), c('net', 'Net', 'money')],
    sql: `select m.method, coalesce(p.n, 0)::int as payments, coalesce(p.amt, 0) as collected, coalesce(r.amt, 0) as refunded, coalesce(p.amt, 0) - coalesce(r.amt, 0) as net
          from (select unnest(array['cash','gcash','maya','bank_transfer','credit_card','debit_card']) as method) m
          left join (select method, count(*) as n, sum(amount) as amt from payments where ${inRange('created_at')} group by method) p on p.method = m.method
          left join (select method, sum(amount) as amt from refunds where ${inRange('created_at')} group by method) r on r.method = m.method
          order by net desc`,
  },
  top_customers: {
    title: 'Top Customers', group: 'Business', chart: { x: 'customer', y: 'spent' },
    columns: [c('customer', 'Customer'), c('player_no', 'Player ID'), c('transactions', 'Transactions', 'number'), c('spent', 'Total Billed', 'money'), c('paid', 'Net Paid', 'money')],
    sql: `select t.customer_name as customer, p.player_no, count(*)::int as transactions, sum(t.total) as spent, sum(t.amount_paid - t.refunded_total) as paid
          from transactions t left join players p on p.id = t.player_id where ${inRange('t.created_at')} and t.status <> 'refunded'
          group by t.customer_name, p.player_no order by spent desc limit 50`,
  },
  most_booked_courts: {
    title: 'Most Booked Courts', group: 'Business', chart: { x: 'court', y: 'bookings' },
    columns: [c('court', 'Court'), c('bookings', 'Bookings', 'number'), c('hours', 'Hours', 'number'), c('value', 'Booking Value', 'money')],
    sql: `select c.name as court, count(r.id)::int as bookings, coalesce(sum(r.duration_hours), 0)::float as hours, coalesce(sum(r.total_amount), 0) as value
          from courts c left join reservations r on r.court_id = c.id and r.status not in ('cancelled','no_show') and ${inRange('r.start_at')}
          group by c.name order by bookings desc`,
  },
  peak_hours: {
    title: 'Peak Booking Hours', group: 'Business', chart: { x: 'hour', y: 'bookings' },
    columns: [c('hour', 'Start Hour'), c('bookings', 'Bookings', 'number'), c('hours', 'Hours Booked', 'number')],
    sql: `select to_char(r.start_at at time zone 'Asia/Manila', 'HH24') || ':00' as hour, count(*)::int as bookings, sum(r.duration_hours)::float as hours
          from reservations r where r.status not in ('cancelled','no_show') and ${inRange('r.start_at')} group by 1 order by 1`,
  },
  membership_growth: {
    title: 'Membership Growth', group: 'Business', chart: { x: 'month', y: 'new_members' },
    columns: [c('month', 'Month'), c('new_members', 'New', 'number'), c('renewals', 'Renewals', 'number'), c('plan_changes', 'Upgrades / Downgrades', 'number'), c('sales', 'Sales', 'money')],
    sql: `select to_char(mth, 'YYYY-MM') as month,
            count(pm.id) filter (where pm.action = 'new')::int as new_members, count(pm.id) filter (where pm.action = 'renewal')::int as renewals,
            count(pm.id) filter (where pm.action in ('upgrade','downgrade'))::int as plan_changes, coalesce(sum(pm.price_paid), 0) as sales
          from ${months} left join player_memberships pm on date_trunc('month', manila_date(pm.created_at)) = mth group by mth order by mth`,
  },
  membership_expiration: {
    title: 'Membership Expiration', group: 'Business',
    columns: [c('membership_no', 'Membership No.'), c('player', 'Player'), c('contact_number', 'Contact'), c('plan', 'Plan'), c('end_date', 'Expires', 'date'), c('days_left', 'Days Left', 'number'), c('status', 'Status')],
    sql: `select pm.membership_no, p.full_name as player, p.contact_number, mp.name as plan, pm.end_date, (pm.end_date - manila_today()) as days_left,
            case when pm.status = 'active' and pm.end_date < manila_today() then 'expired' else pm.status end as status
          from player_memberships pm join players p on p.id = pm.player_id join membership_plans mp on mp.id = pm.plan_id
          where pm.end_date between $1::date and $2::date and pm.status in ('active','suspended','expired') order by pm.end_date`,
  },
  equipment_rentals: {
    title: 'Equipment Rental Summary', group: 'Business', chart: { x: 'equipment', y: 'charges' },
    columns: [c('equipment', 'Equipment'), c('rentals', 'Rentals', 'number'), c('units', 'Units', 'number'), c('free_units', 'Free (Member)', 'number'), c('damaged', 'Damaged', 'number'), c('missing', 'Missing', 'number'), c('charges', 'Charges', 'money')],
    sql: `select e.name as equipment, count(er.id)::int as rentals, coalesce(sum(er.quantity), 0)::int as units,
            coalesce(sum(er.quantity) filter (where er.is_free_entitlement), 0)::int as free_units,
            coalesce(sum(er.qty_damaged), 0)::int as damaged, coalesce(sum(er.qty_missing), 0)::int as missing, coalesce(sum(er.charge), 0) as charges
          from equipment e left join equipment_rentals er on er.equipment_id = e.id and ${inRange('er.rented_at')} group by e.name order by charges desc`,
  },
  inventory_summary: {
    title: 'Product Inventory & Valuation', group: 'Business', noDates: true,
    columns: [c('code', 'Code'), c('product', 'Product'), c('category', 'Category'), c('stock_qty', 'In Stock', 'number'), c('min_stock', 'Minimum', 'number'), c('stock_status', 'Status'), c('cost_price', 'Cost', 'money'), c('selling_price', 'Price', 'money'), c('cost_value', 'Stock Value (Cost)', 'money'), c('retail_value', 'Stock Value (Retail)', 'money')],
    sql: `select p.code, p.name as product, pc.name as category, p.stock_qty, p.min_stock,
            case when p.stock_qty = 0 then 'Out of stock' when p.stock_qty <= p.min_stock then 'Low stock' else 'OK' end as stock_status,
            p.cost_price, p.selling_price, p.cost_price * p.stock_qty as cost_value, p.selling_price * p.stock_qty as retail_value
          from products p left join product_categories pc on pc.id = p.category_id
          where p.status = 'active' and ($1::date is not null or $2::date is not null or true) order by p.name`,
  },
  cancelled_reservations: {
    title: 'Cancelled & No-show Reservations', group: 'Business',
    columns: [c('reference_no', 'Reference'), c('date', 'Booked For', 'date'), c('court', 'Court'), c('customer_name', 'Customer'), c('status', 'Status'), c('cancel_reason', 'Reason'), c('total_amount', 'Value', 'money'), c('amount_paid', 'Paid (unrefunded)', 'money')],
    sql: `select r.reference_no, to_char(r.start_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date, c.name as court, r.customer_name, r.status, r.cancel_reason, r.total_amount, r.amount_paid
          from reservations r join courts c on c.id = r.court_id where r.status in ('cancelled','no_show') and ${inRange('r.start_at')} order by r.start_at`,
  },
  refunds: {
    title: 'Refund Summary', group: 'Business',
    columns: [c('refund_no', 'Refund No.'), c('created_at', 'Date', 'datetime'), c('transaction_no', 'Transaction'), c('customer_name', 'Customer'), c('method', 'Method'), c('reason', 'Reason'), c('requested_by', 'Requested By'), c('approved_by', 'Approved By'), c('amount', 'Amount', 'money')],
    sql: `select r.refund_no, r.created_at, t.transaction_no, t.customer_name, r.method, r.reason, rq.full_name as requested_by, ap.full_name as approved_by, r.amount
          from refunds r join transactions t on t.id = r.transaction_id join employees rq on rq.id = r.requested_by join employees ap on ap.id = r.approved_by
          where ${inRange('r.created_at')} order by r.created_at`,
  },
};

export const reportsRouter = Router();

reportsRouter.get('/', can('reports.view'), (_req, res) => {
  res.json(Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, group: r.group, no_dates: !!r.noDates })));
});

reportsRouter.get('/:id', can('reports.view'), async (req, res) => {
  const report = REPORTS[String(req.params.id)];
  if (!report) throw notFound('Report');
  const from = parse(zDate, req.query.from), to = parse(zDate, req.query.to);
  const { rows } = await db.query(report.sql, [from, to]);
  const totals: Record<string, string> = {};
  for (const col of report.columns.filter((x) => x.type === 'money')) {
    totals[col.key] = rows.reduce((a, r) => a + Math.round(Number(r[col.key] ?? 0) * 100), 0) / 100 + '';
  }
  res.json({ id: req.params.id, title: report.title, group: report.group, columns: report.columns, chart: report.chart ?? null, from, to, rows, totals });
});
