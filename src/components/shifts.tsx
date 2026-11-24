// Cashier shift controls: open, cash in/out, drawer expenses, close with reconciliation, printable report.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Lock, Printer, Unlock } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { PAYMENT_LABELS, type PaymentMethod } from '@shared/permissions';
import { api } from '@/lib/api';
import { useSettings } from '@/lib/auth';
import { printElement } from '@/lib/export';
import { fmtDateTime, labelize, peso } from '@/lib/format';
import { FormDialog } from './forms';
import { Badge, Button, Card, Dialog, LoadingBlock } from './ui';

export function useCurrentShift(enabled = true) {
  return useQuery({ queryKey: ['shift', 'current'], queryFn: () => api.get('/shifts/current'), enabled });
}

export function ShiftReport({ shift }: { shift: any }) {
  const s = shift.summary;
  const settings = useSettings();
  const Row = ({ l, v, bold }: { l: string; v: React.ReactNode; bold?: boolean }) => <div className={`row ${bold ? 'bold' : ''}`}><span>{l}</span><span>{v}</span></div>;
  return (
    <div className="print-doc">
      <div className="center"><div className="big">{settings.data?.business_name ?? 'E-Kourt'}</div><div className="bold">CASHIER SHIFT REPORT</div></div>
      <hr />
      <Row l="Shift No." v={shift.shift_no} bold />
      <Row l="Cashier" v={shift.cashier_name} />
      <Row l="Opened" v={fmtDateTime(shift.opened_at)} />
      <Row l="Closed" v={shift.closed_at ? fmtDateTime(shift.closed_at) : 'STILL OPEN'} />
      {shift.closed_by_name && <Row l="Closed by" v={shift.closed_by_name} />}
      <hr />
      <Row l="Transactions" v={s.transactions} />
      <Row l="Total billed" v={peso(s.sales_total)} />
      {s.by_method.map((p: any) => <Row key={p.method} l={`  ${PAYMENT_LABELS[p.method as PaymentMethod]} (${p.count})`} v={peso(p.amount)} />)}
      <Row l="Non-cash total" v={peso(s.non_cash_sales)} />
      <Row l="Refunds (all methods)" v={`-${peso(s.refunds_total)}`} />
      <hr />
      <div className="bold">CASH DRAWER</div>
      <Row l="Opening cash fund" v={peso(s.opening_cash)} />
      <Row l="+ Cash sales" v={peso(s.cash_sales)} />
      <Row l="+ Cash in" v={peso(s.cash_in)} />
      <Row l="- Cash out" v={peso(s.cash_out)} />
      <Row l="- Expenses paid" v={peso(s.expenses)} />
      <Row l="- Cash refunds" v={peso(s.cash_refunds)} />
      <Row l="EXPECTED CASH" v={peso(shift.expected_cash ?? s.expected_cash)} bold />
      {shift.status === 'closed' && (
        <>
          <Row l="ACTUAL CASH" v={peso(shift.actual_cash)} bold />
          <Row l={Number(shift.variance) < 0 ? 'SHORTAGE' : Number(shift.variance) > 0 ? 'OVERAGE' : 'BALANCED'} v={peso(Math.abs(Number(shift.variance)))} bold />
        </>
      )}
      {shift.movements.length > 0 && (
        <>
          <hr />
          <div className="bold">CASH MOVEMENTS</div>
          {shift.movements.map((mv: any) => <Row key={mv.id} l={`${labelize(mv.movement_type)}: ${mv.reason}`} v={peso(mv.amount)} />)}
        </>
      )}
      {shift.notes && <><hr /><div>Notes: {shift.notes}</div></>}
      <hr />
      <div className="center muted">Printed {fmtDateTime(new Date())}</div>
    </div>
  );
}

export function ShiftReportDialog({ shiftId, onClose }: { shiftId: string | null; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const shift = useQuery({ queryKey: ['shift', shiftId], queryFn: () => api.get(`/shifts/${shiftId}`), enabled: !!shiftId });
  return (
    <Dialog open={!!shiftId} onOpenChange={(o) => !o && onClose()} title="Cashier Shift Report" size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={() => printElement(ref.current, 80)} disabled={!shift.data}><Printer />Print</Button></>}>
      {!shift.data ? <LoadingBlock /> : <div ref={ref} className="mx-auto max-w-[320px] rounded-lg border border-zinc-200 p-4"><ShiftReport shift={shift.data} /></div>}
    </Dialog>
  );
}

/** Compact shift bar shown at the top of the POS. */
export function ShiftBar() {
  const qc = useQueryClient();
  const shift = useCurrentShift();
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get('/expense-categories') });
  const [dialog, setDialog] = React.useState<null | 'open' | 'cash_in' | 'cash_out' | 'expense' | 'close'>(null);
  const [report, setReport] = React.useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['shift'] });
  const s = shift.data;

  if (shift.isLoading) return <Card className="p-3 text-sm text-zinc-500">Checking shift…</Card>;
  return (
    <>
      {!s ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-sm text-amber-900"><Lock className="size-4" /><span><b>No open shift.</b> Open a shift to start accepting payments.</span></div>
          <Button onClick={() => setDialog('open')}><Unlock />Open Shift</Button>
        </Card>
      ) : (
        <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Badge tone="green">Shift open</Badge>
            <span className="font-semibold text-zinc-900">{s.shift_no}</span>
            <span className="text-zinc-500">since {fmtDateTime(s.opened_at)}</span>
            <span className="text-zinc-600">Expected cash <b className="text-zinc-900">{peso(s.summary.expected_cash)}</b></span>
            <span className="text-zinc-600">{s.summary.transactions} sale(s)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setDialog('cash_in')}><ArrowDownToLine />Cash In</Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('cash_out')}><ArrowUpFromLine />Cash Out</Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('expense')}>Expense</Button>
            <Button variant="outline" size="sm" onClick={() => setReport(s.id)}><Printer />Report</Button>
            <Button variant="dark" size="sm" onClick={() => setDialog('close')}><Lock />Close Shift</Button>
          </div>
        </Card>
      )}

      <FormDialog open={dialog === 'open'} onOpenChange={(o) => !o && setDialog(null)} title="Open Cashier Shift" size="sm" submitLabel="Open shift"
        description="Count the cash in the drawer before you start."
        fields={[{ name: 'opening_cash', label: 'Opening cash fund (₱)', type: 'money', required: true, full: true, default: '0' }]}
        onSubmit={async (v) => { await api.post('/shifts/open', v); toast.success('Shift opened'); refresh(); }} />

      <FormDialog open={dialog === 'cash_in' || dialog === 'cash_out' || dialog === 'expense'} onOpenChange={(o) => !o && setDialog(null)} size="sm"
        title={dialog === 'cash_in' ? 'Record Cash In' : dialog === 'cash_out' ? 'Record Cash Out' : 'Record Expense Paid From Drawer'}
        description={dialog === 'expense' ? 'The expense is sent for approval and deducted from expected cash.' : undefined}
        fields={[
          { name: 'amount', label: 'Amount (₱)', type: 'money', required: true, full: true },
          ...(dialog === 'expense' ? [{ name: 'category_id', label: 'Category', type: 'select' as const, required: true, full: true, options: (categories.data ?? []).filter((c: any) => c.is_active).map((c: any) => ({ value: c.id, label: c.name })) }] : []),
          { name: 'reason', label: dialog === 'expense' ? 'Description' : 'Reason', type: 'textarea', required: true },
        ]}
        onSubmit={async (v) => { await api.post('/shifts/movements', { ...v, movement_type: dialog }); toast.success('Recorded'); refresh(); }} />

      {s && (
        <FormDialog open={dialog === 'close'} onOpenChange={(o) => !o && setDialog(null)} title="Close Shift" size="sm" submitLabel="Close shift"
          description={`Expected cash in drawer: ${peso(s.summary.expected_cash)}. Count the drawer and enter the actual amount.`}
          fields={[
            { name: 'actual_cash', label: 'Actual cash counted (₱)', type: 'money', required: true, full: true },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onSubmit={async (v) => {
            const closed = await api.post(`/shifts/${s.id}/close`, v);
            const variance = Number(closed.variance);
            toast[variance === 0 ? 'success' : 'warning'](variance === 0 ? 'Shift closed — drawer balanced' : `Shift closed — ${variance < 0 ? 'shortage' : 'overage'} of ${peso(Math.abs(variance))}`);
            refresh();
            setReport(s.id);
          }} />
      )}
      <ShiftReportDialog shiftId={report} onClose={() => setReport(null)} />
    </>
  );
}
