import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgePercent, BarChart3, Bell, CalendarDays, ClipboardList, CreditCard, HandCoins, IdCard, LayoutDashboard, LogOut, Menu, Package,
  ReceiptText, ScrollText, Settings, ShoppingCart, UserCog, Users, Wallet, X,
} from 'lucide-react';
import * as React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { ROLE_LABELS, type Permission } from '@shared/permissions';
import { api, errMsg } from '@/lib/api';
import { useAuth, useSettings } from '@/lib/auth';
import { cn, fmtDateTime, manila } from '@/lib/format';
import { FormDialog } from './forms';
import { Button } from './ui';

export const NAV: { to: string; label: string; icon: React.ComponentType<{ className?: string }>; perms: Permission[] }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perms: ['dashboard.view'] },
  { to: '/pos', label: 'POS / Cashier', icon: ShoppingCart, perms: ['pos.use'] },
  { to: '/reservations', label: 'Court Reservations', icon: CalendarDays, perms: ['reservations.view'] },
  { to: '/players', label: 'Player Management', icon: Users, perms: ['players.view'] },
  { to: '/memberships', label: 'Membership Management', icon: IdCard, perms: ['memberships.view'] },
  { to: '/pricing', label: 'Pricing & Packages', icon: BadgePercent, perms: ['pricing.manage', 'discounts.manage'] },
  { to: '/inventory', label: 'Products & Inventory', icon: Package, perms: ['inventory.manage', 'rentals.manage'] },
  { to: '/services', label: 'Services & Other Charges', icon: ClipboardList, perms: ['services.manage'] },
  { to: '/transactions', label: 'Transactions', icon: ReceiptText, perms: ['transactions.view', 'shifts.own', 'shifts.view_all'] },
  { to: '/expenses', label: 'Expenses', icon: Wallet, perms: ['expenses.view'] },
  { to: '/reports', label: 'Reports & Analytics', icon: BarChart3, perms: ['reports.view'] },
  { to: '/employees', label: 'Employee Management', icon: UserCog, perms: ['employees.manage'] },
  { to: '/settings', label: 'System Settings', icon: Settings, perms: ['settings.manage'] },
  { to: '/audit-logs', label: 'Audit Logs', icon: ScrollText, perms: ['audit.view'] },
];

function Notifications() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 120_000 });
  const read = useMutation({ mutationFn: (id?: string) => api.post('/notifications/read', id ? { id } : {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = list.data?.unread ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Notifications (${unread} unread)`} className="relative rounded-lg p-2 text-zinc-600 hover:bg-zinc-100">
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-zinc-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && <button className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => read.mutate(undefined)}>Mark all read</button>}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {!list.data?.rows.length && <p className="px-4 py-8 text-center text-sm text-zinc-500">You're all caught up.</p>}
              {list.data?.rows.map((n: any) => (
                <button key={n.id} onClick={() => !n.is_read && read.mutate(n.id)} className={cn('block w-full border-b border-zinc-50 px-4 py-3 text-left hover:bg-zinc-50', !n.is_read && 'bg-brand-50/50')}>
                  <p className="text-sm font-medium text-zinc-900">{n.title}</p>
                  <p className="text-xs text-zinc-600">{n.message}</p>
                  <p className="mt-1 text-[11px] text-zinc-400">{fmtDateTime(n.created_at)}</p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Clock() {
  const [now, setNow] = React.useState(() => manila());
  React.useEffect(() => { const t = setInterval(() => setNow(manila()), 30_000); return () => clearInterval(t); }, []);
  return <span className="hidden text-sm text-zinc-500 md:block">{now.format('ddd, MMM D · h:mm A')} <span className="text-zinc-400">PHT</span></span>;
}

export function Layout() {
  const { user, can, logout } = useAuth();
  const settings = useSettings();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [pwOpen, setPwOpen] = React.useState(false);
  React.useEffect(() => setMobileOpen(false), [location.pathname]);
  const items = NAV.filter((n) => can(...n.perms));
  const current = NAV.find((n) => (n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)));

  const sidebar = (
    <div className="dark-scroll flex h-full flex-col bg-ink-900 text-zinc-300">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-600/30"><CreditCard className="size-5" /></div>
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold leading-tight tracking-tight text-white">{settings.data?.business_name ?? 'E-Kourt'}</p>
          <p className="text-[11px] uppercase tracking-widest text-zinc-500">POS &amp; Management</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4" aria-label="Main">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}
            className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-zinc-400 hover:bg-ink-700 hover:text-white')}>
            <n.icon className="size-[18px] shrink-0" />
            <span className="truncate">{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-ink-700 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink-600 text-sm font-bold text-white">{user?.full_name.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{user?.full_name}</p>
            <p className="truncate text-xs text-zinc-500">{user ? ROLE_LABELS[user.role] : ''}</p>
          </div>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <button onClick={() => setPwOpen(true)} className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-zinc-400 hover:bg-ink-700 hover:text-white"><HandCoins className="size-3.5" />Password</button>
          <button onClick={() => logout()} className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-zinc-400 hover:bg-ink-700 hover:text-white"><LogOut className="size-3.5" />Sign out</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="animate-fade absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">{sidebar}</aside>
          <button onClick={() => setMobileOpen(false)} aria-label="Close menu" className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white"><X className="size-5" /></button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 lg:hidden"><Menu className="size-5" /></button>
            <p className="truncate text-sm font-semibold text-zinc-800">{current?.label ?? 'E-Kourt'}</p>
          </div>
          <div className="flex items-center gap-3">
            <Clock />
            <Notifications />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6"><Outlet /></main>
      </div>
      <FormDialog open={pwOpen} onOpenChange={setPwOpen} title="Change Password" size="sm" submitLabel="Update password"
        fields={[
          { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true },
          { name: 'new_password', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 8 characters. Other devices will be signed out.' },
        ]}
        onSubmit={async (v) => { await api.post('/auth/change-password', v).catch((e) => { throw new Error(errMsg(e)); }); toast.success('Password updated'); }} />
    </div>
  );
}

export function NoAccess() {
  return (
    <div className="mx-auto mt-20 max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-card">
      <p className="text-lg font-semibold text-zinc-900">You don't have access to this page</p>
      <p className="mt-2 text-sm text-zinc-500">Ask a Super Admin if you need this permission.</p>
      <Button className="mt-5" onClick={() => history.back()}>Go back</Button>
    </div>
  );
}
