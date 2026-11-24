import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CalendarCheck, CircleDollarSign, IdCard, LandPlot, Receipt, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardHeader, DataTable, EmptyState, ErrorBlock, LoadingBlock, PageHeader, StatCard, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, fmtDateTime, fmtTime, labelize, manila, peso } from '@/lib/format';

const PALETTE = ['#e2520f', '#17171a', '#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#ef4444'];
const COURT_COLORS: Record<string, string> = {
  available: 'border-emerald-300 bg-emerald-50 text-emerald-800', reserved: 'border-sky-300 bg-sky-50 text-sky-800',
  occupied: 'border-orange-300 bg-orange-50 text-orange-800', maintenance: 'border-amber-300 bg-amber-50 text-amber-800', closed: 'border-zinc-300 bg-zinc-100 text-zinc-600',
};

function ChartCard({ title, description, empty, children, className }: { title: string; description?: string; empty?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader title={title} description={description} />
      <div className="h-64 p-3">{empty ? <EmptyState title="No data yet" hint="This chart fills in as transactions are recorded." /> : <ResponsiveContainer width="100%" height="100%">{children as any}</ResponsiveContainer>}</div>
    </Card>
  );
}

export function CourtBoard() {
  const board = useQuery({ queryKey: ['courts', 'board'], queryFn: () => api.get('/courts/board'), refetchInterval: 60_000 });
  if (board.isLoading) return <LoadingBlock />;
  if (board.error) return <ErrorBlock error={board.error} onRetry={() => board.refetch()} />;
  return (
    <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
      {board.data.map((c: any) => (
        <div key={c.id} className={cn('rounded-xl border-2 p-3', COURT_COLORS[c.live_status])}>
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-bold">{c.name}</p>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">{c.live_status === 'maintenance' ? 'Maintenance' : labelize(c.live_status)}</span>
          </div>
          <p className="mt-2 min-h-9 text-xs leading-snug opacity-90">
            {c.current_ref ? <>{c.current_customer}<br />until {fmtTime(c.current_until)}</> : c.next_at ? <>Next: {fmtTime(c.next_at)}<br />{c.next_customer}</> : c.live_status === 'available' ? 'Free for the rest of today' : labelize(c.court_type)}
          </p>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { user, can } = useAuth();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard'), refetchInterval: 60_000 });
  if (dash.isLoading) return <LoadingBlock label="Loading dashboard…" />;
  if (dash.error) return <ErrorBlock error={dash.error} onRetry={() => dash.refetch()} />;
  const d = dash.data;
  const s = d.stats;
  const fin = d.financials;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <PageHeader title={`Good ${manila().hour() < 12 ? 'morning' : manila().hour() < 18 ? 'afternoon' : 'evening'}, ${user?.full_name.split(' ')[0]}`} description={manila().format('dddd, MMMM D, YYYY') + ' · live figures from your database'} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {fin && <StatCard label="Today's Revenue" value={peso(s.today_revenue)} hint="Payments less refunds" icon={Banknote} tone="brand" />}
        <StatCard label="Today's Transactions" value={s.today_transactions} icon={Receipt} tone="zinc" />
        <StatCard label="Today's Reservations" value={s.today_reservations} icon={CalendarCheck} tone="blue" />
        <StatCard label="Occupied Courts" value={`${s.occupied_courts} / ${s.total_courts}`} hint={`${s.available_courts} available now`} icon={LandPlot} tone="amber" />
        {!fin && <StatCard label="Available Courts" value={s.available_courts} icon={LandPlot} tone="green" />}
        <StatCard label="Registered Players" value={s.total_players} icon={Users} tone="zinc" />
        <StatCard label="Active Members" value={s.active_members} icon={IdCard} tone="green" />
        <StatCard label="Expiring Memberships" value={s.expiring_memberships} hint="Within the notice window" icon={AlertTriangle} tone={s.expiring_memberships > 0 ? 'red' : 'zinc'} />
        {fin && <StatCard label="Available Courts" value={s.available_courts} icon={LandPlot} tone="green" />}
        {fin && <StatCard label="Monthly Revenue" value={peso(s.month_revenue)} icon={TrendingUp} tone="green" />}
        {fin && <StatCard label="Monthly Expenses" value={peso(s.month_expenses)} hint="Approved expenses" icon={TrendingDown} tone="red" />}
        {fin && <StatCard label="Net Income (Month)" value={peso(s.net_income)} hint="Estimated, cash basis" icon={CircleDollarSign} tone={Number(s.net_income) >= 0 ? 'brand' : 'red'} />}
        <StatCard label="Low-stock Products" value={s.low_stock_products} hint={`${s.open_rentals} rental(s) out`} icon={AlertTriangle} tone={s.low_stock_products > 0 ? 'amber' : 'zinc'} />
      </div>

      <Card>
        <CardHeader title="Court Availability" description="Live status of every court" action={<Link to="/reservations" className="text-xs font-semibold text-brand-700 hover:underline">Open reservations →</Link>} />
        <CourtBoard />
      </Card>

      {fin && (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Daily Revenue" description="Last 14 days" empty={!d.daily_revenue.some((r: any) => r.revenue !== 0)}>
            <BarChart data={d.daily_revenue.map((r: any) => ({ ...r, label: r.date.slice(5) }))}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={55} tickFormatter={(v) => `₱${v >= 1000 ? `${v / 1000}k` : v}`} />
              <Tooltip formatter={(v: any) => peso(v)} cursor={{ fill: '#f4f4f5' }} />
              <Bar dataKey="revenue" name="Revenue" fill="#e2520f" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Monthly Revenue vs Expenses" description="Last 6 months" empty={!d.monthly_revenue.some((r: any) => r.revenue !== 0 || r.expenses !== 0)}>
            <LineChart data={d.monthly_revenue}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={55} tickFormatter={(v) => `₱${v >= 1000 ? `${v / 1000}k` : v}`} />
              <Tooltip formatter={(v: any) => peso(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#e2520f" strokeWidth={2.5} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#17171a" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ChartCard>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ChartCard title="Reservation Statistics" description="By status, last 30 days" empty={!d.reservation_stats.length}>
          <PieChart>
            <Pie data={d.reservation_stats.map((r: any) => ({ name: labelize(r.status), value: r.count }))} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {d.reservation_stats.map((_: any, i: number) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ChartCard>
        <ChartCard title="Most Frequently Used Courts" description="Bookings, last 30 days" empty={!d.top_courts.some((c: any) => c.bookings > 0)}>
          <BarChart data={d.top_courts} layout="vertical" margin={{ left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eee" />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={70} />
            <Tooltip cursor={{ fill: '#f4f4f5' }} />
            <Bar dataKey="bookings" name="Bookings" fill="#17171a" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Most Purchased Products" description="Units sold, last 30 days" empty={!d.top_products.length}>
          <BarChart data={d.top_products} layout="vertical" margin={{ left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eee" />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={120} />
            <Tooltip cursor={{ fill: '#f4f4f5' }} />
            <Bar dataKey="qty" name="Units" fill="#e2520f" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Membership Distribution" description="Currently valid memberships" empty={!d.membership_distribution.some((m: any) => m.count > 0)}>
          <PieChart>
            <Pie data={d.membership_distribution.map((m: any) => ({ name: m.name, value: m.count }))} dataKey="value" nameKey="name" outerRadius={80}>
              {d.membership_distribution.map((_: any, i: number) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ChartCard>
        {fin && (
          <ChartCard title="Payment Method Distribution" description="Collected, last 30 days" empty={!d.payment_methods.length}>
            <PieChart>
              <Pie data={d.payment_methods.map((m: any) => ({ name: labelize(m.method), value: m.amount }))} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {d.payment_methods.map((_: any, i: number) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip formatter={(v: any) => peso(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ChartCard>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        {can('transactions.view') && (
          <Card>
            <CardHeader title="Recent Transactions" action={<Link to="/transactions" className="text-xs font-semibold text-brand-700 hover:underline">View all →</Link>} />
            <DataTable rows={d.recent_transactions} empty="No transactions yet" emptyHint="Completed sales from the POS appear here."
              columns={[
                { key: 'transaction_no', label: 'Transaction No.', className: 'font-medium text-zinc-900' },
                { key: 'customer_name', label: 'Customer' },
                { key: 'created_at', label: 'Date', render: (r: any) => fmtDateTime(r.created_at) },
                { key: 'transaction_type', label: 'Type', render: (r: any) => labelize(r.transaction_type) },
                { key: 'payment_methods', label: 'Payment', render: (r: any) => labelize(r.payment_methods) },
                { key: 'total', label: 'Amount', align: 'right', render: (r: any) => <span className="font-semibold text-zinc-900">{peso(r.total)}</span> },
                { key: 'cashier_name', label: 'Cashier' },
                { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
          </Card>
        )}
        <Card>
          <CardHeader title="Today's Reservations" description={`${d.today_reservations.length} booking(s)`} />
          <DataTable rows={d.today_reservations} empty="No reservations today"
            columns={[
              { key: 'reference_no', label: 'Reference', className: 'font-medium text-zinc-900' },
              { key: 'customer_name', label: 'Customer' },
              { key: 'court_name', label: 'Court' },
              { key: 'start_time', label: 'Start', render: (r: any) => fmtTime(r.start_time) },
              { key: 'end_time', label: 'End', render: (r: any) => fmtTime(r.end_time) },
              { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            ]} />
        </Card>
      </div>
    </div>
  );
}
