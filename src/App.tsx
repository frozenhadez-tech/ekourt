import * as React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@shared/permissions';
import { Layout, NAV, NoAccess } from './components/Layout';
import { LoadingBlock } from './components/ui';
import { useAuth } from './lib/auth';
import Login from './pages/Login';

const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const POS = React.lazy(() => import('./pages/POS'));
const Reservations = React.lazy(() => import('./pages/Reservations'));
const Players = React.lazy(() => import('./pages/Players'));
const Memberships = React.lazy(() => import('./pages/Memberships'));
const Pricing = React.lazy(() => import('./pages/Pricing'));
const Inventory = React.lazy(() => import('./pages/Inventory'));
const Services = React.lazy(() => import('./pages/Services'));
const Transactions = React.lazy(() => import('./pages/Transactions'));
const Expenses = React.lazy(() => import('./pages/Expenses'));
const Reports = React.lazy(() => import('./pages/Reports'));
const Admin = React.lazy(() => import('./pages/Admin'));

function Guard({ path, children }: { path: string; children: React.ReactNode }) {
  const { can } = useAuth();
  const perms = NAV.find((n) => n.to === path)?.perms ?? ([] as Permission[]);
  return can(...perms) ? <>{children}</> : <NoAccess />;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex h-dvh items-center justify-center"><LoadingBlock label="Starting E-Kourt…" /></div>;
  if (!user) return <Login />;
  const page = (path: string, el: React.ReactNode) => <Route path={path === '/' ? undefined : path} index={path === '/'} element={<Guard path={path}>{el}</Guard>} />;
  return (
    <React.Suspense fallback={<div className="flex h-dvh items-center justify-center"><LoadingBlock /></div>}>
      <Routes>
        <Route element={<Layout />}>
          {page('/', <Dashboard />)}
          {page('/pos', <POS />)}
          {page('/reservations', <Reservations />)}
          {page('/players', <Players />)}
          {page('/memberships', <Memberships />)}
          {page('/pricing', <Pricing />)}
          {page('/inventory', <Inventory />)}
          {page('/services', <Services />)}
          {page('/transactions', <Transactions />)}
          {page('/expenses', <Expenses />)}
          {page('/reports', <Reports />)}
          {page('/employees', <Admin tab="employees" />)}
          {page('/settings', <Admin tab="settings" />)}
          {page('/audit-logs', <Admin tab="audit" />)}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </React.Suspense>
  );
}
