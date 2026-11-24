import { CreditCard, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { Button, Field, Input } from '@/components/ui';
import { errMsg } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        {/* Court-line motif */}
        <svg className="absolute inset-0 size-full opacity-[0.07]" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <g fill="none" stroke="#fff" strokeWidth="4"><rect x="90" y="80" width="420" height="640" /><path d="M90 400h420M90 300h420M90 500h420M300 80v220M300 500v220" /></g>
        </svg>
        <div className="relative flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-brand-600"><CreditCard className="size-6" /></div>
          <span className="text-2xl font-extrabold tracking-tight">E-Kourt</span>
        </div>
        <div className="relative">
          <h1 className="max-w-md text-4xl font-extrabold leading-tight tracking-tight">Run every court, sale and shift from one screen.</h1>
          <p className="mt-4 max-w-md text-zinc-400">Reservations, cashiering, memberships, inventory and reports for your pickleball facility.</p>
        </div>
        <p className="relative flex items-center gap-2 text-xs text-zinc-500"><ShieldCheck className="size-4" />Role-based access · Audited transactions · Asia/Manila time</p>
      </div>
      <div className="flex items-center justify-center bg-zinc-100 p-6">
        <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-card">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white"><CreditCard className="size-5" /></div>
            <span className="text-xl font-extrabold tracking-tight">E-Kourt</span>
          </div>
          <h2 className="text-xl font-bold text-zinc-900">Sign in</h2>
          <p className="mb-6 mt-1 text-sm text-zinc-500">E-Kourt POS &amp; Management System</p>
          <div className="space-y-4">
            <Field label="Email"><Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@ekourt.ph" /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Sign in</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
