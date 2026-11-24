import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import type { Permission, Role } from '@shared/permissions';
import { api } from './api';

export interface User {
  id: string;
  employee_no: string;
  full_name: string;
  email: string;
  role: Role;
  permissions: Permission[];
}

interface AuthState {
  user: User | null;
  loading: boolean;
  can: (...perms: Permission[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
    const onExpired = () => { setUser(null); qc.clear(); };
    window.addEventListener('ekourt:unauthenticated', onExpired);
    return () => window.removeEventListener('ekourt:unauthenticated', onExpired);
  }, [qc]);

  // Live updates: any write by any signed-in device refreshes the data on this screen.
  React.useEffect(() => {
    if (!user) return;
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries(), 250);
    };
    return () => { clearTimeout(timer); es.close(); };
  }, [user, qc]);

  const value = React.useMemo<AuthState>(() => ({
    user,
    loading,
    can: (...perms) => !!user && perms.some((p) => user.permissions.includes(p)),
    login: async (email, password) => { const r = await api.post('/auth/login', { email, password }); qc.clear(); setUser(r.user); },
    logout: async () => { await api.post('/auth/logout').catch(() => {}); qc.clear(); setUser(null); },
  }), [user, loading, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export interface Settings {
  business_name: string; business_address: string; business_contact: string; business_tin: string; receipt_footer: string;
  vat_registered: boolean; vat_rate: number; sc_pwd_discount_rate: number; sc_pwd_eligible_types: string[]; member_discount_types: string[];
  require_open_shift: boolean; membership_expiry_notice_days: number; booking_slot_minutes: number; max_advance_booking_days: number;
  duration_months: Record<string, number>;
}
export const useSettings = () => useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api.get('/settings'), staleTime: 60_000 });
