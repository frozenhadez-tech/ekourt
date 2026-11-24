// Shared cashier building blocks: player picker, tender entry, manager approval and receipts.
import { useQuery } from '@tanstack/react-query';
import { Plus, Printer, Search, Trash2, UserRound, X } from 'lucide-react';
import * as React from 'react';
import { PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/permissions';
import { api } from '@/lib/api';
import { useSettings } from '@/lib/auth';
import { printElement } from '@/lib/export';
import { cn, fmtDate, fmtDateTime, fromCents, labelize, peso, toCents } from '@/lib/format';
import { Badge, Button, Dialog, Field, Input, LoadingBlock, Select, StatusBadge } from './ui';

// ---- Player picker ------------------------------------------------------------
export interface PlayerLite { id: string; player_no: string; full_name: string; contact_number?: string; membership_status?: string; plan_name?: string; membership_end?: string }

export function PlayerPicker({ value, onChange, placeholder = 'Search player by name, ID or phone…' }: { value: PlayerLite | null; onChange: (p: PlayerLite | null) => void; placeholder?: string }) {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const term = React.useDeferredValue(q.trim());
  const results = useQuery<PlayerLite[]>({ queryKey: ['players', 'pick', term], queryFn: () => api.get('/players', { q: term, limit: 8, status: 'active' }), enabled: open && term.length >= 2 });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="rounded-full bg-white p-1.5 text-brand-700"><UserRound className="size-4" /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900">{value.full_name}</p>
            <p className="truncate text-xs text-zinc-600">{value.player_no}{value.membership_status === 'active' ? ` · ${value.plan_name} until ${fmtDate(value.membership_end)}` : ' · No active membership'}</p>
          </div>
        </div>
        <button onClick={() => onChange(null)} aria-label="Clear player" className="rounded p-1 text-zinc-500 hover:bg-white"><X className="size-4" /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-3 size-4 text-zinc-400" />
      <Input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={placeholder} className="pl-9" />
      {open && term.length >= 2 && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {results.isLoading && <p className="px-3 py-2 text-sm text-zinc-500">Searching…</p>}
          {results.data?.length === 0 && <p className="px-3 py-2 text-sm text-zinc-500">No registered player matches “{term}”.</p>}
          {results.data?.map((p) => (
            <button key={p.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(p); setQ(''); setOpen(false); }} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-50">
              <span className="min-w-0"><span className="block truncate text-sm font-medium text-zinc-900">{p.full_name}</span><span className="block text-xs text-zinc-500">{p.player_no} · {p.contact_number ?? 'no phone'}</span></span>
              {p.membership_status === 'active' && <Badge tone="green">{p.plan_name}</Badge>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tender entry ---------------------------------------------------------------
export interface PaymentLine { method: PaymentMethod; amount: string; reference_no: string }

export function tenderSummary(lines: PaymentLine[], due: string | number) {
  const dueC = toCents(due);
  const nonCash = lines.filter((l) => l.method !== 'cash').reduce((a, l) => a + toCents(l.amount), 0);
  const cash = lines.filter((l) => l.method === 'cash').reduce((a, l) => a + toCents(l.amount), 0);
  const cashApplied = Math.max(0, Math.min(cash, dueC - nonCash));
  const paid = nonCash + cashApplied;
  return { tendered: nonCash + cash, paid, change: cash - cashApplied, balance: Math.max(0, dueC - paid), nonCashOver: nonCash > dueC };
}

export function PaymentFields({ lines, onChange, due }: { lines: PaymentLine[]; onChange: (lines: PaymentLine[]) => void; due: string | number }) {
  const s = tenderSummary(lines, due);
  const set = (i: number, patch: Partial<PaymentLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remainingFor = (i: number) => fromCents(Math.max(0, toCents(due) - lines.reduce((a, l, j) => (j === i ? a : a + toCents(l.amount)), 0)));
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 sm:grid-cols-[9rem_1fr_1fr_auto]">
          <Select value={l.method} onChange={(e) => set(i, { method: e.target.value as PaymentMethod })} aria-label="Payment method">
            {PAYMENT_METHODS.map((mth) => <option key={mth} value={mth}>{PAYMENT_LABELS[mth]}</option>)}
          </Select>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-2.5 text-sm text-zinc-400">₱</span>
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0.00" className="pl-7 text-right font-semibold" aria-label="Amount received" />
          </div>
          <Input value={l.reference_no} onChange={(e) => set(i, { reference_no: e.target.value })} placeholder={l.method === 'cash' ? 'Note (optional)' : 'Reference no.'} className="col-span-2 sm:col-span-1" disabled={l.method === 'cash'} aria-label="Reference number" />
          <div className="col-start-3 row-start-1 flex gap-1 sm:col-start-4">
            <Button variant="outline" size="sm" className="h-10" onClick={() => set(i, { amount: remainingFor(i) })}>Exact</Button>
            {lines.length > 1 && <Button variant="ghost" size="icon" className="h-10 text-red-600" aria-label="Remove payment" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>}
          </div>
        </div>
      ))}
      <button onClick={() => onChange([...lines, { method: 'gcash', amount: '', reference_no: '' }])} className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"><Plus className="size-3.5" />Split with another payment method</button>
      <div className="grid grid-cols-3 gap-2 rounded-lg bg-zinc-50 p-3 text-center">
        <div><p className="text-[11px] uppercase tracking-wide text-zinc-500">Received</p><p className="text-sm font-bold text-zinc-900">{peso(fromCents(s.tendered))}</p></div>
        <div><p className="text-[11px] uppercase tracking-wide text-zinc-500">Change</p><p className="text-sm font-bold text-emerald-700">{peso(fromCents(s.change))}</p></div>
        <div><p className="text-[11px] uppercase tracking-wide text-zinc-500">Balance</p><p className={cn('text-sm font-bold', s.balance > 0 ? 'text-amber-700' : 'text-zinc-900')}>{peso(fromCents(s.balance))}</p></div>
      </div>
      {s.nonCashOver && <p className="text-xs font-medium text-red-600">Non-cash payments cannot exceed the amount due.</p>}
    </div>
  );
}

export const cleanPayments = (lines: PaymentLine[]) =>
  lines.filter((l) => toCents(l.amount) > 0).map((l) => ({ method: l.method, amount: Number(l.amount).toFixed(2), reference_no: l.method === 'cash' ? null : l.reference_no || null }));

// ---- Manager approval -----------------------------------------------------------
export interface Approver { email: string; password: string }
export function ApproverFields({ value, onChange, reason }: { value: Approver; onChange: (v: Approver) => void; reason: string }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="mb-2 text-xs font-semibold text-amber-900">Manager approval required — {reason}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input type="email" placeholder="Manager email" autoComplete="off" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} />
        <Input type="password" placeholder="Manager password" autoComplete="new-password" value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} />
      </div>
    </div>
  );
}

// ---- Receipt ----------------------------------------------------------------------
export function ReceiptDialog({ transactionId, onClose, reprint }: { transactionId: string | null; onClose: () => void; reprint?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const trx = useQuery({ queryKey: ['transaction', transactionId], queryFn: () => api.get(`/transactions/${transactionId}`), enabled: !!transactionId });
  const t = trx.data;
  const s = settings.data;
  const print = () => {
    printElement(ref.current, 80);
    if (reprint && transactionId) api.post(`/transactions/${transactionId}/reprint`).catch(() => {});
  };
  return (
    <Dialog open={!!transactionId} onOpenChange={(o) => !o && onClose()} title={reprint ? 'Reprint Receipt' : 'Receipt'} size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={print} disabled={!t}><Printer />Print</Button></>}>
      {!t || !s ? <LoadingBlock /> : (
        <div className="mx-auto w-full max-w-[320px] rounded-lg border border-zinc-200 p-4 shadow-inner">
          <div ref={ref} className="print-doc">
            <div className="center">
              <div className="big">{s.business_name}</div>
              {s.business_address && <div>{s.business_address}</div>}
              {s.business_contact && <div>{s.business_contact}</div>}
              {s.business_tin && <div>{s.vat_registered ? 'VAT REG TIN' : 'NON-VAT REG TIN'}: {s.business_tin}</div>}
              {reprint && <div className="bold">*** REPRINT ***</div>}
            </div>
            <hr />
            <div className="row"><span>Txn No:</span><span className="bold">{t.transaction_no}</span></div>
            <div className="row"><span>Date:</span><span>{fmtDateTime(t.created_at)}</span></div>
            <div className="row"><span>Cashier:</span><span>{t.cashier_name}</span></div>
            <div className="row"><span>Customer:</span><span>{t.customer_name}{t.player_no ? ` (${t.player_no})` : ''}</span></div>
            {t.reservation_no && <div className="row"><span>Booking:</span><span>{t.reservation_no}</span></div>}
            <hr />
            <table>
              <tbody>
                {t.items.map((it: any) => (
                  <React.Fragment key={it.id}>
                    <tr><td colSpan={2}>{it.description}</td></tr>
                    <tr>
                      <td className="muted">&nbsp;&nbsp;{Number(it.quantity)} x {peso(it.unit_price)}</td>
                      <td className="right">{peso(Number(it.unit_price) * Number(it.quantity))}</td>
                    </tr>
                    {Number(it.discount_amount) > 0 && <tr><td className="muted">&nbsp;&nbsp;Less discount</td><td className="right">-{peso(it.discount_amount)}</td></tr>}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            <hr />
            <div className="row"><span>Subtotal</span><span>{peso(t.subtotal)}</span></div>
            {Number(t.discount_total) > 0 && <div className="row"><span>Discount{t.discount_label ? ` (${t.discount_label})` : ''}</span><span>-{peso(t.discount_total)}</span></div>}
            {t.discount_id_number && <div className="row muted"><span>SC/PWD ID</span><span>{t.discount_id_number}</span></div>}
            <div className="row big"><span>TOTAL</span><span>{peso(t.total)}</span></div>
            {s.vat_registered && (
              <>
                <div className="row muted"><span>VATable Sales</span><span>{peso(t.vatable_sales)}</span></div>
                <div className="row muted"><span>VAT ({s.vat_rate}%)</span><span>{peso(t.vat_amount)}</span></div>
                <div className="row muted"><span>VAT-Exempt Sales</span><span>{peso(t.vat_exempt_sales)}</span></div>
              </>
            )}
            <hr />
            {t.payments.map((p: any) => (
              <div className="row" key={p.id}><span>{PAYMENT_LABELS[p.method as PaymentMethod]}{p.kind !== 'payment' ? ` (${p.kind})` : ''}{p.reference_no ? ` #${p.reference_no}` : ''}</span><span>{peso(p.tendered)}</span></div>
            ))}
            <div className="row"><span>Amount Received</span><span>{peso(t.payments.reduce((a: number, p: any) => a + toCents(p.tendered), 0) / 100)}</span></div>
            <div className="row"><span>Change</span><span>{peso(t.payments.reduce((a: number, p: any) => a + toCents(p.tendered) - toCents(p.amount), 0) / 100)}</span></div>
            {Number(t.balance) > 0 && <div className="row bold"><span>REMAINING BALANCE</span><span>{peso(t.balance)}</span></div>}
            {t.refunds.map((r: any) => <div className="row bold" key={r.id}><span>REFUND {r.refund_no}</span><span>-{peso(r.amount)}</span></div>)}
            <hr />
            <div className="center">
              <div>Status: {labelize(t.status)}</div>
              {s.receipt_footer && <div>{s.receipt_footer}</div>}
              {!s.vat_registered && <div className="muted">This document is not valid for claim of input tax.</div>}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Collect a balance payment on a partially paid transaction. */
export function TxnStatus({ t }: { t: { status: string; balance: string } }) {
  return <span className="inline-flex items-center gap-1.5"><StatusBadge status={t.status} />{Number(t.balance) > 0 && t.status === 'partial' && <span className="text-xs font-medium text-amber-700">{peso(t.balance)} due</span>}</span>;
}

export function ShiftGate({ children }: { children: (shift: any | null, loading: boolean) => React.ReactNode }) {
  const shift = useQuery({ queryKey: ['shift', 'current'], queryFn: () => api.get('/shifts/current') });
  return <>{children(shift.data ?? null, shift.isLoading)}</>;
}

export { Field };
