import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, HandCoins, Printer, Undo2 } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/permissions';
import { ApproverFields, cleanPayments, PaymentFields, ReceiptDialog, tenderSummary, TxnStatus, type Approver, type PaymentLine } from '@/components/pos';
import { ShiftReportDialog } from '@/components/shifts';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, LoadingBlock, PageHeader, SearchInput, Select, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { api, errMsg, newKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { exportCSV, exportXLSX, type ExportColumn } from '@/lib/export';
import { addDays, fmtDateTime, labelize, peso, today } from '@/lib/format';

const EXPORT_COLS: ExportColumn[] = [
  { key: 'transaction_no', label: 'Transaction No.' }, { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'customer_name', label: 'Customer' },
  { key: 'transaction_type', label: 'Type' }, { key: 'payment_methods', label: 'Payment Method' }, { key: 'cashier_name', label: 'Cashier' },
  { key: 'subtotal', label: 'Subtotal', type: 'money' }, { key: 'discount_total', label: 'Discount', type: 'money' }, { key: 'total', label: 'Total', type: 'money' },
  { key: 'amount_paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'refunded_total', label: 'Refunded', type: 'money' }, { key: 'status', label: 'Status' },
];

export default function Transactions() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = React.useState(() => addDays(today(), -30));
  const [to, setTo] = React.useState(today);
  const [q, setQ] = React.useState('');
  const [cashier, setCashier] = React.useState('');
  const [method, setMethod] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<string | null>(params.get('open'));
  const [shiftReport, setShiftReport] = React.useState<string | null>(null);
  const filters = { from, to, q, cashier_id: cashier, method, status };
  const viewTx = can('transactions.view');
  const list = useQuery({ queryKey: ['transactions', filters, page], queryFn: () => api.get('/transactions', { ...filters, page, limit: 50 }), enabled: viewTx });
  const employees = useQuery({ queryKey: ['employees', 'short'], queryFn: () => api.get('/employees') });
  const shifts = useQuery({ queryKey: ['shift', 'list'], queryFn: () => api.get('/shifts'), enabled: can('shifts.own', 'shifts.view_all') });
  React.useEffect(() => { if (params.get('open')) setParams({}, { replace: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => setPage(1), [from, to, q, cashier, method, status]);

  const doExport = async (kind: 'csv' | 'xlsx') => {
    try {
      const all = await api.get('/transactions', { ...filters, limit: 5000 });
      const name = `ekourt-transactions-${from}-to-${to}`;
      if (kind === 'csv') exportCSV(name, EXPORT_COLS, all.rows); else await exportXLSX(name, EXPORT_COLS, all.rows, 'Transactions');
    } catch (e) { toast.error(errMsg(e)); }
  };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.count / list.data.limit)) : 1;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Transactions" description="Permanent transaction history. Completed sales are never edited or deleted; corrections are made with refund records.">
        {viewTx && <><Button variant="outline" onClick={() => doExport('csv')}><Download />CSV</Button><Button variant="outline" onClick={() => doExport('xlsx')}><FileSpreadsheet />Excel</Button></>}
      </PageHeader>
      <Tabs defaultValue={viewTx ? 'transactions' : 'shifts'}>
        <TabsList>
          {viewTx && <TabsTrigger value="transactions">Transaction History</TabsTrigger>}
          {can('shifts.own', 'shifts.view_all') && <TabsTrigger value="shifts">Cashier Shifts</TabsTrigger>}
        </TabsList>
        <TabsContent value="transactions">
          <Card>
            <CardHeader title="Transactions" description={list.data ? `${list.data.count} transaction(s) · billed ${peso(list.data.total)} · net collected ${peso(list.data.collected)}` : ' '} action={
              <div className="flex flex-wrap items-center gap-2">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From date" />
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To date" />
                {can('shifts.view_all', 'reports.view') && (
                  <Select value={cashier} onChange={(e) => setCashier(e.target.value)} className="w-44" aria-label="Cashier">
                    <option value="">All cashiers</option>
                    {employees.data?.map((e: any) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                  </Select>
                )}
                <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-40" aria-label="Payment method">
                  <option value="">All methods</option>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
                </Select>
                <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Status">
                  <option value="">All statuses</option>
                  {['completed', 'partial', 'partially_refunded', 'refunded'].map((s) => <option key={s} value={s}>{labelize(s)}</option>)}
                </Select>
                <SearchInput value={q} onChange={setQ} placeholder="Transaction no. or customer…" />
              </div>} />
            <DataTable rows={list.data?.rows} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} onRowClick={(r: any) => setOpen(r.id)} empty="No transactions match these filters"
              columns={[
                { key: 'transaction_no', label: 'Transaction No.', className: 'font-medium text-zinc-900' },
                { key: 'customer_name', label: 'Customer' },
                { key: 'created_at', label: 'Date', render: (r: any) => fmtDateTime(r.created_at) },
                { key: 'transaction_type', label: 'Type', render: (r: any) => labelize(r.transaction_type) },
                { key: 'total', label: 'Total', align: 'right', render: (r: any) => <b className="text-zinc-900">{peso(r.total)}</b> },
                { key: 'payment_methods', label: 'Payment', render: (r: any) => labelize(r.payment_methods) },
                { key: 'cashier_name', label: 'Cashier' },
                { key: 'status', label: 'Status', render: (r: any) => <TxnStatus t={r} /> },
              ]} />
            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 text-sm text-zinc-600">
                <span>Page {page} of {pages}</span>
                <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
              </div>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="shifts">
          <Card>
            <CardHeader title="Cashier Shifts" description="Open and close shifts from the POS screen. Click a shift for its reconciliation report." />
            <DataTable rows={shifts.data} loading={shifts.isLoading} error={shifts.error} onRowClick={(r: any) => setShiftReport(r.id)} empty="No shifts yet"
              columns={[
                { key: 'shift_no', label: 'Shift', className: 'font-medium text-zinc-900' }, { key: 'cashier_name', label: 'Cashier' },
                { key: 'opened_at', label: 'Opened', render: (r: any) => fmtDateTime(r.opened_at) }, { key: 'closed_at', label: 'Closed', render: (r: any) => fmtDateTime(r.closed_at) },
                { key: 'transactions', label: 'Sales', align: 'center' }, { key: 'opening_cash', label: 'Opening', align: 'right', render: (r: any) => peso(r.opening_cash) },
                { key: 'collected', label: 'Collected', align: 'right', render: (r: any) => peso(r.collected) },
                { key: 'expected_cash', label: 'Expected cash', align: 'right', render: (r: any) => (r.expected_cash == null ? '—' : peso(r.expected_cash)) },
                { key: 'actual_cash', label: 'Actual cash', align: 'right', render: (r: any) => (r.actual_cash == null ? '—' : peso(r.actual_cash)) },
                { key: 'variance', label: 'Over / (Short)', align: 'right', render: (r: any) => r.variance == null ? '—' : <b className={Number(r.variance) < 0 ? 'text-red-600' : Number(r.variance) > 0 ? 'text-amber-700' : 'text-emerald-700'}>{peso(r.variance)}</b> },
                { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
          </Card>
        </TabsContent>
      </Tabs>
      <TransactionDetail id={open} onClose={() => setOpen(null)} />
      <ShiftReportDialog shiftId={shiftReport} onClose={() => setShiftReport(null)} />
    </div>
  );
}

function TransactionDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [receipt, setReceipt] = React.useState(false);
  const [mode, setMode] = React.useState<null | 'refund' | 'pay'>(null);
  const trx = useQuery({ queryKey: ['transaction', id], queryFn: () => api.get(`/transactions/${id}`), enabled: !!id });
  const t = trx.data;
  React.useEffect(() => setMode(null), [id]);
  const refundable = t ? Number(t.net_paid) : 0;
  return (
    <>
      <Dialog open={!!id && !receipt} onOpenChange={(o) => !o && onClose()} title={t ? t.transaction_no : 'Transaction'} description={t ? `${fmtDateTime(t.created_at)} · ${t.cashier_name}${t.shift_no ? ` · ${t.shift_no}` : ''}` : undefined} size="lg"
        footer={t && !mode && (
          <>
            <Button variant="outline" onClick={() => setReceipt(true)}><Printer />Reprint receipt</Button>
            {can('refunds.request', 'refunds.approve') && refundable > 0 && <Button variant="outline" className="text-red-700" onClick={() => setMode('refund')}><Undo2 />Refund</Button>}
            {can('pos.use') && t.status === 'partial' && Number(t.balance) > 0 && <Button onClick={() => setMode('pay')}><HandCoins />Collect balance</Button>}
          </>)}>
        {!t ? <LoadingBlock /> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><TxnStatus t={t} /><Badge>{labelize(t.transaction_type)}</Badge>{t.reservation_no && <Badge tone="blue">{t.reservation_no}</Badge>}</div>
            <p className="text-sm text-zinc-700">Customer: <b>{t.customer_name}</b>{t.player_no ? ` (${t.player_no})` : ''}</p>
            <DataTable rows={t.items} columns={[
              { key: 'description', label: 'Item' }, { key: 'item_type', label: 'Type', render: (r: any) => labelize(r.item_type) },
              { key: 'quantity', label: 'Qty', align: 'right', render: (r: any) => Number(r.quantity) }, { key: 'unit_price', label: 'Unit price', align: 'right', render: (r: any) => peso(r.unit_price) },
              { key: 'discount_amount', label: 'Discount', align: 'right', render: (r: any) => (Number(r.discount_amount) > 0 ? `−${peso(r.discount_amount)}` : '—') },
              { key: 'line_total', label: 'Total', align: 'right', render: (r: any) => <b>{peso(r.line_total)}</b> },
            ]} />
            <div className="grid gap-4 sm:grid-cols-2">
              <dl className="space-y-1 rounded-xl bg-zinc-50 p-4 text-sm">
                {[['Subtotal', peso(t.subtotal)], [`Discount${t.discount_label ? ` (${t.discount_label})` : ''}`, `−${peso(t.discount_total)}`], ['Total', peso(t.total)], ['Amount paid', peso(t.amount_paid)], ['Refunded', `−${peso(t.refunded_total)}`], ['Remaining balance', peso(t.balance)]]
                  .map(([l, v], i) => <div key={l} className={`flex justify-between ${i === 2 ? 'border-y border-dashed border-zinc-300 py-1 text-base font-bold' : ''}`}><dt className="text-zinc-600">{l}</dt><dd className="font-medium text-zinc-900">{v}</dd></div>)}
                {t.approved_by_name && <p className="pt-1 text-xs text-zinc-500">Discount approved by {t.approved_by_name}{t.discount_id_number ? ` · ID ${t.discount_id_number}` : ''}</p>}
              </dl>
              <div className="space-y-2 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Payment history</p>
                {!t.payments.length && <p className="text-zinc-500">No payments recorded.</p>}
                {t.payments.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2">
                    <span>{PAYMENT_LABELS[p.method as PaymentMethod]} <span className="text-xs text-zinc-500">· {labelize(p.kind)}{p.reference_no ? ` · #${p.reference_no}` : ''}<br />{fmtDateTime(p.created_at)} · {p.received_by_name}</span></span><b>{peso(p.amount)}</b>
                  </div>
                ))}
                {t.refunds.map((r: any) => (
                  <div key={r.id} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-900">
                    <div className="flex justify-between"><span>Refund {r.refund_no} · {PAYMENT_LABELS[r.method as PaymentMethod]}</span><b>−{peso(r.amount)}</b></div>
                    <p className="text-xs">{r.reason} · requested by {r.requested_by_name}, approved by {r.approved_by_name} · {fmtDateTime(r.created_at)}{r.restocked ? ' · items restocked' : ''}</p>
                  </div>
                ))}
              </div>
            </div>
            {mode === 'refund' && <RefundForm t={t} max={refundable} onDone={() => { setMode(null); qc.invalidateQueries(); }} onCancel={() => setMode(null)} />}
            {mode === 'pay' && <BalanceForm t={t} onDone={() => { setMode(null); qc.invalidateQueries(); }} onCancel={() => setMode(null)} />}
          </div>
        )}
      </Dialog>
      <ReceiptDialog transactionId={receipt ? id : null} onClose={() => setReceipt(false)} reprint />
    </>
  );
}

function RefundForm({ t, max, onDone, onCancel }: { t: any; max: number; onDone: () => void; onCancel: () => void }) {
  const { can } = useAuth();
  const [amount, setAmount] = React.useState(max.toFixed(2));
  const [method, setMethod] = React.useState<PaymentMethod>(t.payments[0]?.method ?? 'cash');
  const [reason, setReason] = React.useState('');
  const [restock, setRestock] = React.useState(false);
  const [approver, setApprover] = React.useState<Approver>({ email: '', password: '' });
  const [busy, setBusy] = React.useState(false);
  const selfApprove = can('refunds.approve');
  const hasProducts = t.items.some((i: any) => i.item_type === 'product');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/transactions/${t.id}/refunds`, { amount, method, reason, restock, approver: selfApprove ? null : approver });
      toast.success('Refund recorded');
      onDone();
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-red-200 bg-red-50/40 p-4">
      <p className="text-sm font-semibold text-red-900">Process refund — up to {peso(max)} refundable</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Refund amount (₱)"><Input type="number" min="0.01" max={max} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Refund method"><Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}</Select></Field>
      </div>
      <Field label="Reason"><Textarea required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-14" /></Field>
      {hasProducts && <label className="flex items-center gap-2 text-sm text-zinc-700"><input type="checkbox" className="size-4 accent-brand-600" checked={restock} onChange={(e) => setRestock(e.target.checked)} />Return products to stock (full refunds only)</label>}
      {!selfApprove && <ApproverFields value={approver} onChange={setApprover} reason="refunds must be authorised by a manager" />}
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Back</Button><Button type="submit" variant="danger" loading={busy}>Confirm refund</Button></div>
    </form>
  );
}

function BalanceForm({ t, onDone, onCancel }: { t: any; onDone: () => void; onCancel: () => void }) {
  const [lines, setLines] = React.useState<PaymentLine[]>([{ method: 'cash', amount: '', reference_no: '' }]);
  const [key] = React.useState(newKey);
  const [busy, setBusy] = React.useState(false);
  const s = tenderSummary(lines, t.balance);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/transactions/${t.id}/payments`, { idempotency_key: key, payments: cleanPayments(lines) });
      toast.success('Payment recorded');
      onDone();
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <p className="text-sm font-semibold text-zinc-900">Collect balance — {peso(t.balance)} outstanding</p>
      <PaymentFields lines={lines} onChange={setLines} due={t.balance} />
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Back</Button><Button loading={busy} disabled={s.paid <= 0 || s.nonCashOver} onClick={submit}>Record {peso(s.paid / 100)}</Button></div>
    </div>
  );
}
