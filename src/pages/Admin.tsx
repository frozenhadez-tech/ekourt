// Employee management, system settings and the audit log.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ROLE_LABELS, ROLE_PERMISSIONS, ROLES, type Role } from '@shared/permissions';
import { FormDialog, FormFields, type FieldDef } from '@/components/forms';
import { Badge, Button, Card, CardHeader, DataTable, Input, LoadingBlock, PageHeader, SearchInput, Select } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useAuth, useSettings } from '@/lib/auth';
import { addDays, fmtDate, fmtDateTime, labelize, today } from '@/lib/format';

export default function Admin({ tab }: { tab: 'employees' | 'settings' | 'audit' }) {
  return tab === 'employees' ? <Employees /> : tab === 'settings' ? <SettingsPage /> : <AuditLogs />;
}

// ---------------------------------------------------------------------------
function Employees() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = React.useState<{ open: boolean; row: any | null }>({ open: false, row: null });
  const list = useQuery({ queryKey: ['employees', 'full'], queryFn: () => api.get('/employees') });
  const fields: FieldDef[] = [
    { name: 'full_name', label: 'Full name', required: true },
    { name: 'email', label: 'Login email', type: 'email', required: true },
    { name: 'role', label: 'Role', type: 'select', required: true, default: 'cashier', options: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
    { name: 'position', label: 'Position / title' },
    { name: 'contact_number', label: 'Contact number' },
    { name: 'hire_date', label: 'Hire date', type: 'date' },
    { name: 'password', label: form.row ? 'Reset password (leave blank to keep)' : 'Password', type: 'password', required: !form.row, hint: 'Minimum 8 characters.' },
    { name: 'is_active', label: 'Account', type: 'checkbox', default: true, placeholder: 'Active (can sign in)' },
  ];
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Employee Management" description="Accounts and roles. Permissions are enforced by the server on every request, not just hidden in the interface.">
        <Button onClick={() => setForm({ open: true, row: null })}><Plus />Add Employee</Button>
      </PageHeader>
      <Card>
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} columns={[
          { key: 'employee_no', label: 'Employee No.', className: 'font-medium text-zinc-900' },
          { key: 'full_name', label: 'Name', render: (r: any) => <>{r.full_name}{r.id === user?.id && <Badge className="ml-2" tone="blue">You</Badge>}</> },
          { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role', render: (r: any) => <Badge tone={{ super_admin: 'red', admin: 'orange', manager: 'violet', cashier: 'blue', receptionist: 'green' }[r.role as Role]}>{ROLE_LABELS[r.role as Role]}</Badge> },
          { key: 'position', label: 'Position' }, { key: 'contact_number', label: 'Contact' },
          { key: 'last_login_at', label: 'Last sign-in', render: (r: any) => fmtDateTime(r.last_login_at) },
          { key: 'is_active', label: 'Status', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Deactivated'}</Badge> },
          { key: '_a', label: '', align: 'right', render: (r: any) => <Button variant="ghost" size="icon" aria-label="Edit employee" onClick={() => setForm({ open: true, row: r })}><Pencil /></Button> },
        ]} />
      </Card>
      <Card className="mt-4">
        <CardHeader title="Role Permissions" description="What each role is allowed to do." />
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-5">
          {ROLES.map((r) => (
            <div key={r}>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-zinc-900"><ShieldCheck className="size-4 text-brand-600" />{ROLE_LABELS[r]}</p>
              <ul className="space-y-0.5 text-xs text-zinc-600">{ROLE_PERMISSIONS[r].map((p) => <li key={p}>{labelize(p.replace('.', ': '))}</li>)}</ul>
            </div>
          ))}
        </div>
      </Card>
      <FormDialog open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} title={form.row ? `Edit ${form.row.full_name}` : 'Add Employee'} fields={fields} initial={form.row ? { ...form.row, password: '' } : null}
        description={form.row ? 'Changing the role, password or status signs the employee out everywhere.' : undefined}
        onSubmit={async (v) => { if (form.row) await api.put(`/employees/${form.row.id}`, v); else await api.post('/employees', v); toast.success('Employee saved'); qc.invalidateQueries({ queryKey: ['employees'] }); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
const TYPES = [{ value: 'court', label: 'Court rental' }, { value: 'product', label: 'Products' }, { value: 'service', label: 'Services' }, { value: 'equipment', label: 'Equipment rental' }];
const SECTIONS: { title: string; description: string; fields: FieldDef[] }[] = [
  { title: 'Business Profile', description: 'Printed on receipts, booking slips and ID cards.', fields: [
    { name: 'business_name', label: 'Business name', required: true }, { name: 'business_contact', label: 'Contact information' },
    { name: 'business_address', label: 'Business address', full: true }, { name: 'business_tin', label: 'TIN (optional)' }, { name: 'receipt_footer', label: 'Receipt footer message' },
  ] },
  { title: 'Tax & Statutory Discounts', description: 'Senior Citizen (RA 9994) and PWD (RA 10754) discounts are applied only when a cashier selects them and enters the ID number. Confirm the right setup with your accountant.', fields: [
    { name: 'vat_registered', label: 'VAT registration', type: 'checkbox', placeholder: 'Business is VAT-registered (prices are VAT-inclusive)', full: true, hint: 'When on: receipts show the VAT breakdown, and Senior/PWD sales are VAT-exempt with the discount taken from the VAT-exclusive price. When off: the discount is taken from the selling price.' },
    { name: 'vat_rate', label: 'VAT rate (%)', type: 'number' }, { name: 'sc_pwd_discount_rate', label: 'Senior / PWD discount rate (%)', type: 'number' },
    { name: 'sc_pwd_eligible_types', label: 'Items eligible for Senior / PWD discount', type: 'multi', options: [...TYPES, { value: 'membership', label: 'Memberships' }, { value: 'charge', label: 'Other charges' }] },
    { name: 'member_discount_types', label: 'Items that receive the membership discount', type: 'multi', options: TYPES },
  ] },
  { title: 'Operations', description: 'Booking and cashiering rules.', fields: [
    { name: 'require_open_shift', label: 'Cashier shifts', type: 'checkbox', placeholder: 'Require an open shift before accepting payments', full: true },
    { name: 'booking_slot_minutes', label: 'Booking start-time interval', type: 'select', required: true, options: [{ value: '60', label: 'Every 60 minutes' }, { value: '30', label: 'Every 30 minutes' }] },
    { name: 'max_advance_booking_days', label: 'Advance booking window for non-members (days)', type: 'number' },
    { name: 'membership_expiry_notice_days', label: 'Membership renewal notice (days before expiry)', type: 'number' },
  ] },
];

function SettingsPage() {
  const qc = useQueryClient();
  const settings = useSettings();
  const [values, setValues] = React.useState<Record<string, any> | null>(null);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => { if (settings.data && !values) setValues({ ...settings.data, booking_slot_minutes: String(settings.data.booking_slot_minutes) }); }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!values) return <LoadingBlock />;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/settings', { ...values, booking_slot_minutes: Number(values.booking_slot_minutes) });
      toast.success('Settings saved');
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) { toast.error(errMsg(err)); } finally { setSaving(false); }
  };
  const months = values.duration_months ?? {};
  return (
    <form onSubmit={save} className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="System Settings" description="Currency: Philippine Peso (₱) · Timezone: Asia/Manila"><Button type="submit" loading={saving}>Save settings</Button></PageHeader>
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardHeader title={s.title} description={s.description} />
          <div className="p-5"><FormFields fields={s.fields} values={values} onChange={(n, v) => setValues((x) => ({ ...x!, [n]: v }))} /></div>
        </Card>
      ))}
      <Card>
        <CardHeader title="Membership Durations" description="Number of months billed for each duration (price = monthly price × months)." />
        <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
          {(['monthly', 'quarterly', 'semi_annual', 'annual'] as const).map((k) => (
            <div key={k}><label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-600">{labelize(k)}</label>
              <Input type="number" min={1} value={months[k] ?? ''} onChange={(e) => setValues((x) => ({ ...x!, duration_months: { ...months, [k]: e.target.value } }))} /></div>
          ))}
        </div>
      </Card>
      <div className="flex justify-end"><Button type="submit" loading={saving}>Save settings</Button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
function AuditLogs() {
  const [from, setFrom] = React.useState(() => addDays(today(), -7));
  const [to, setTo] = React.useState(today);
  const [q, setQ] = React.useState('');
  const [area, setArea] = React.useState('');
  const [employee, setEmployee] = React.useState('');
  const [page, setPage] = React.useState(1);
  const employees = useQuery({ queryKey: ['employees', 'short'], queryFn: () => api.get('/employees') });
  const logs = useQuery({ queryKey: ['audit', from, to, q, area, employee, page], queryFn: () => api.get('/audit-logs', { from, to, q, action: area, employee_id: employee, page, limit: 100 }) });
  React.useEffect(() => setPage(1), [from, to, q, area, employee]);
  const pages = logs.data ? Math.max(1, Math.ceil(logs.data.count / logs.data.limit)) : 1;
  const summarize = (d: any) => {
    if (!d || !Object.keys(d).length) return '—';
    if (d.changes) return Object.entries(d.changes).map(([k, v]: any) => `${labelize(k)}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join('; ');
    return Object.entries(d).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${labelize(k)}: ${v}`).join(' · ') || JSON.stringify(d);
  };
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Audit Logs" description="A permanent, read-only record of sign-ins and every important business action. Entries cannot be edited or deleted, even by administrators." />
      <Card>
        <CardHeader title="Activity" description={`${logs.data?.count ?? 0} entr${logs.data?.count === 1 ? 'y' : 'ies'}`} action={
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
            <Select value={area} onChange={(e) => setArea(e.target.value)} className="w-40" aria-label="Area"><option value="">All areas</option>{logs.data?.areas.map((a: string) => <option key={a} value={a}>{labelize(a)}</option>)}</Select>
            <Select value={employee} onChange={(e) => setEmployee(e.target.value)} className="w-44" aria-label="Employee"><option value="">All employees</option>{employees.data?.map((e: any) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</Select>
            <SearchInput value={q} onChange={setQ} placeholder="Search details…" />
          </div>} />
        <DataTable rows={logs.data?.rows} loading={logs.isLoading} error={logs.error} empty="No activity in this range" columns={[
          { key: 'created_at', label: 'When', render: (r: any) => fmtDateTime(r.created_at), className: 'whitespace-nowrap' },
          { key: 'employee_name', label: 'Employee', render: (r: any) => r.employee_name ?? <span className="text-zinc-400">System / unknown</span> },
          { key: 'action', label: 'Action', render: (r: any) => <Badge tone={r.action.includes('fail') || r.action.includes('cancel') || r.action.includes('refund') ? 'red' : r.action.startsWith('auth') ? 'zinc' : 'blue'}>{labelize(r.action)}</Badge> },
          { key: 'details', label: 'Details', className: 'max-w-[38rem] whitespace-normal break-words text-xs', render: (r: any) => summarize(r.details) },
          { key: 'ip_address', label: 'IP', className: 'text-xs text-zinc-500' },
        ]} />
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 text-sm text-zinc-600">
            <span>Page {page} of {pages} · {fmtDate(from)} – {fmtDate(to)}</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
    </div>
  );
}
