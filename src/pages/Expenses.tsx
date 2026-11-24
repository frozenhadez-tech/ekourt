import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Check, Paperclip, Pencil, Plus, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/permissions';
import { CrudSection, FormDialog } from '@/components/forms';
import { Badge, Button, Card, CardHeader, DataTable, Input, PageHeader, Select, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, fmtDate, peso, today } from '@/lib/format';

const PERIODS = { day: 'Today', week: 'This week', month: 'This month', year: 'This year', custom: 'Custom' } as const;
type Period = keyof typeof PERIODS;

export default function Expenses() {
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [period, setPeriod] = React.useState<Period>('month');
  const [from, setFrom] = React.useState(() => dayjs(today()).startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = React.useState(today);
  const [status, setStatus] = React.useState('');
  const [form, setForm] = React.useState<{ open: boolean; row: any | null }>({ open: false, row: null });
  const pick = (p: Period) => {
    setPeriod(p);
    if (p === 'custom') return;
    setFrom(p === 'day' ? today() : dayjs(today()).startOf(p).format('YYYY-MM-DD'));
    setTo(today());
  };
  const list = useQuery({ queryKey: ['expenses', from, to, status], queryFn: () => api.get('/expenses', { from, to, status }) });
  const categories = useQuery({ queryKey: ['expense-categories', ''], queryFn: () => api.get('/expense-categories') });
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/expenses/${id}/decision`, { status }),
    onSuccess: (_d, v) => { toast.success(`Expense ${v.status}`); qc.invalidateQueries({ queryKey: ['expenses'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const cents = (key: 'approved' | 'pending') => (list.data?.by_category ?? []).reduce((a: number, c: any) => a + Math.round(Number(c[key]) * 100), 0) / 100;
  const canApprove = can('expenses.approve');

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Expenses" description="Operating expenses, kept separate from revenue. Only approved expenses count toward net operating income.">
        {can('expenses.create', 'expenses.approve') && <Button onClick={() => setForm({ open: true, row: null })}><Plus />Record Expense</Button>}
      </PageHeader>
      <Tabs defaultValue="expenses">
        <TabsList><TabsTrigger value="expenses">Expenses</TabsTrigger><TabsTrigger value="categories">Categories</TabsTrigger></TabsList>
        <TabsContent value="expenses" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-zinc-300 bg-white p-0.5">
              {(Object.keys(PERIODS) as Period[]).map((p) => <button key={p} onClick={() => pick(p)} className={cn('rounded-md px-3 py-1.5 text-xs font-semibold', period === p ? 'bg-ink-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>{PERIODS[p]}</button>)}
            </div>
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPeriod('custom'); }} className="w-40" aria-label="From" />
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPeriod('custom'); }} className="w-40" aria-label="To" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Approval status">
              <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Approved expenses" value={peso(cents('approved'))} hint={`${fmtDate(from)} – ${fmtDate(to)}`} tone="red" />
            <StatCard label="Pending approval" value={peso(cents('pending'))} tone="amber" />
            {(list.data?.by_category ?? []).filter((c: any) => Number(c.approved) > 0).slice(0, 2).map((c: any) => <StatCard key={c.category} label={`Top: ${c.category}`} value={peso(c.approved)} />)}
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
            <Card>
              <CardHeader title="Expense Records" description={`${list.data?.rows.length ?? 0} record(s)`} />
              <DataTable rows={list.data?.rows} loading={list.isLoading} error={list.error} empty="No expenses in this period"
                columns={[
                  { key: 'expense_no', label: 'Expense No.', className: 'font-medium text-zinc-900' },
                  { key: 'expense_date', label: 'Date', render: (r: any) => fmtDate(r.expense_date) },
                  { key: 'category_name', label: 'Category' },
                  { key: 'description', label: 'Description', className: 'max-w-64 truncate', render: (r: any) => <>{r.description}{r.shift_id && <Badge className="ml-2" tone="orange">Drawer</Badge>}</> },
                  { key: 'amount', label: 'Amount', align: 'right', render: (r: any) => <b>{peso(r.amount)}</b> },
                  { key: 'payment_method', label: 'Method', render: (r: any) => PAYMENT_LABELS[r.payment_method as PaymentMethod] },
                  { key: 'recorded_by_name', label: 'Recorded by' },
                  { key: 'attachment_url', label: 'Receipt', align: 'center', render: (r: any) => r.attachment_url ? <a href={r.attachment_url} target="_blank" rel="noreferrer" className="inline-flex text-brand-700" aria-label="Open attachment"><Paperclip className="size-4" /></a> : '—' },
                  { key: 'status', label: 'Approval', render: (r: any) => <><StatusBadge status={r.status} />{r.approved_by_name && <span className="block text-xs text-zinc-500">{r.approved_by_name}</span>}</> },
                  { key: '_a', label: '', align: 'right', render: (r: any) => r.status === 'pending' && (
                    <div className="flex justify-end gap-1">
                      {!r.shift_id && (canApprove || r.recorded_by === user?.id) && <Button variant="ghost" size="icon" aria-label="Edit expense" onClick={() => setForm({ open: true, row: r })}><Pencil /></Button>}
                      {canApprove && <Button variant="ghost" size="icon" aria-label="Approve" className="text-emerald-700 hover:bg-emerald-50" onClick={() => decide.mutate({ id: r.id, status: 'approved' })}><Check /></Button>}
                      {canApprove && <Button variant="ghost" size="icon" aria-label="Reject" className="text-red-600 hover:bg-red-50" onClick={() => decide.mutate({ id: r.id, status: 'rejected' })}><X /></Button>}
                    </div>) },
                ]} />
            </Card>
            <Card>
              <CardHeader title="By Category" description="Approved amounts in this period" />
              <div className="space-y-3 p-4">
                {!(list.data?.by_category ?? []).length && <p className="text-sm text-zinc-500">No data.</p>}
                {(list.data?.by_category ?? []).map((c: any) => {
                  const total = cents('approved') || 1;
                  return (
                    <div key={c.category}>
                      <div className="flex justify-between text-sm"><span className="text-zinc-700">{c.category}</span><b>{peso(c.approved)}</b></div>
                      <div className="mt-1 h-1.5 rounded-full bg-zinc-100"><div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.min(100, (Number(c.approved) / total) * 100)}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="categories">
          <CrudSection title="Expense Categories" endpoint="/expense-categories" queryKey="expense-categories" noun="Category" canManage={canApprove} searchable={false}
            columns={[{ key: 'name', label: 'Category', className: 'font-medium text-zinc-900' }, { key: 'is_active', label: 'Status', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' }]} />
        </TabsContent>
      </Tabs>

      <FormDialog open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} title={form.row ? `Edit ${form.row.expense_no}` : 'Record Expense'} initial={form.row}
        description="New expenses start as Pending until a manager approves them."
        fields={[
          { name: 'expense_date', label: 'Expense date', type: 'date', required: true, default: today() },
          { name: 'category_id', label: 'Category', type: 'select', required: true, options: (categories.data ?? []).filter((c: any) => c.is_active).map((c: any) => ({ value: c.id, label: c.name })) },
          { name: 'amount', label: 'Amount (₱)', type: 'money', required: true },
          { name: 'payment_method', label: 'Payment method', type: 'select', required: true, default: 'cash', options: PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_LABELS[m] })) },
          { name: 'description', label: 'Description', type: 'textarea', required: true },
          { name: 'attachment_url', label: 'Attachment / receipt (image or PDF)', type: 'file', full: true },
        ]}
        onSubmit={async (v) => { if (form.row) await api.put(`/expenses/${form.row.id}`, v); else await api.post('/expenses', v); toast.success('Expense saved'); qc.invalidateQueries({ queryKey: ['expenses'] }); }} />
    </div>
  );
}
