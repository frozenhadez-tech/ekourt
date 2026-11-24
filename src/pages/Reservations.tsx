import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { ChevronLeft, ChevronRight, Clock, Plus, Printer } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CrudSection, FormDialog } from '@/components/forms';
import { cleanPayments, PaymentFields, PlayerPicker, ReceiptDialog, tenderSummary, type PaymentLine, type PlayerLite } from '@/components/pos';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, LoadingBlock, PageHeader, SearchInput, Select, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { api, errMsg, newKey } from '@/lib/api';
import { useAuth, useSettings } from '@/lib/auth';
import { printElement } from '@/lib/export';
import { addDays, cn, fmtDate, fmtDateTime, fmtTime, labelize, peso, STATUS_TONE, today } from '@/lib/format';
import { CourtBoard } from './Dashboard';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SLOT_TONE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-900 border-amber-300', confirmed: 'bg-sky-100 text-sky-900 border-sky-300', checked_in: 'bg-violet-100 text-violet-900 border-violet-300',
  in_progress: 'bg-orange-100 text-orange-900 border-orange-300',
};
type Prefill = { date: string; court_id?: string; start_time?: string };

export default function Reservations() {
  const { can } = useAuth();
  const [booking, setBooking] = React.useState<Prefill | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Court Reservations" description="Availability, bookings, check-in and court setup">
        {can('reservations.manage') && <Button onClick={() => setBooking({ date: today() })}><Plus />New Reservation</Button>}
      </PageHeader>
      <Tabs defaultValue="schedule">
        <TabsList>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="list">All Reservations</TabsTrigger>
          <TabsTrigger value="courts">Courts</TabsTrigger>
        </TabsList>
        <TabsContent value="schedule"><Schedule onBook={can('reservations.manage') ? setBooking : undefined} onOpen={setDetail} /></TabsContent>
        <TabsContent value="list"><ReservationList onOpen={setDetail} /></TabsContent>
        <TabsContent value="courts"><Courts /></TabsContent>
      </Tabs>
      {booking && <BookingDialog prefill={booking} onClose={() => setBooking(null)} onCreated={(id) => { setBooking(null); setDetail(id); }} />}
      <ReservationDetail id={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule: day / week / month
// ---------------------------------------------------------------------------
function Schedule({ onBook, onOpen }: { onBook?: (p: Prefill) => void; onOpen: (id: string) => void }) {
  const [view, setView] = React.useState<'day' | 'week' | 'month'>('day');
  const [date, setDate] = React.useState(today);
  const step = view === 'day' ? 1 : view === 'week' ? 7 : 0;
  const move = (dir: number) => setDate(view === 'month' ? dayjs(date).add(dir, 'month').format('YYYY-MM-DD') : addDays(date, dir * step));
  const weekStart = dayjs(date).startOf('week').format('YYYY-MM-DD');
  const title = view === 'day' ? dayjs(date).format('dddd, MMMM D, YYYY') : view === 'week' ? `${fmtDate(weekStart)} – ${fmtDate(addDays(weekStart, 6))}` : dayjs(date).format('MMMM YYYY');
  return (
    <div className="space-y-4">
      <Card><CardHeader title="Live Court Status" description="Colour-coded: available, reserved, occupied, maintenance, closed" /><CourtBoard /></Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Previous" onClick={() => move(-1)}><ChevronLeft /></Button>
            <Button variant="outline" size="sm" className="h-9" onClick={() => setDate(today())}>Today</Button>
            <Button variant="outline" size="icon" aria-label="Next" onClick={() => move(1)}><ChevronRight /></Button>
            <p className="ml-2 text-sm font-semibold text-zinc-900">{title}</p>
          </div>
          <div className="flex items-center gap-2">
            <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 w-40" aria-label="Go to date" />
            <div className="flex rounded-lg border border-zinc-300 p-0.5">
              {(['day', 'week', 'month'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1.5 text-xs font-semibold capitalize', view === v ? 'bg-ink-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>{v}</button>)}
            </div>
          </div>
        </div>
        {view === 'day' && <DayGrid date={date} onBook={onBook} onOpen={onOpen} />}
        {view === 'week' && <WeekView start={weekStart} onOpen={onOpen} onDay={(d) => { setDate(d); setView('day'); }} />}
        {view === 'month' && <MonthView date={date} onDay={(d) => { setDate(d); setView('day'); }} />}
      </Card>
    </div>
  );
}

function DayGrid({ date, onBook, onOpen }: { date: string; onBook?: (p: Prefill) => void; onOpen: (id: string) => void }) {
  const avail = useQuery({ queryKey: ['availability', date, '1'], queryFn: () => api.get('/reservations/availability', { date, duration: 1 }) });
  if (avail.isLoading) return <LoadingBlock />;
  if (avail.error) return <p className="p-4 text-sm text-red-700">{errMsg(avail.error)}</p>;
  const courts = avail.data.courts;
  const times: string[] = [...new Set<string>(courts.flatMap((c: any) => c.slots.map((s: any) => s.time)))].sort();
  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full min-w-[640px] border-separate border-spacing-1 text-sm">
        <thead><tr><th className="w-20" />{courts.map((c: any) => <th key={c.id} className="rounded-lg bg-ink-900 px-2 py-2 text-xs font-semibold text-white">{c.name}<span className="block font-normal text-zinc-400">{c.is_closed ? 'Closed today' : c.status !== 'available' ? labelize(c.status) : `${fmtTime(c.open_time)}–${fmtTime(c.close_time)}`}</span></th>)}</tr></thead>
        <tbody>
          {times.map((t) => (
            <tr key={t}>
              <td className="pr-2 text-right text-xs font-medium text-zinc-500">{fmtTime(t)}</td>
              {courts.map((c: any) => {
                const slot = c.slots.find((s: any) => s.time === t);
                if (!slot) return <td key={c.id} className="rounded-md bg-zinc-100" />;
                if (slot.reservation) {
                  return <td key={c.id}><button onClick={() => onOpen(slot.reservation.id)} className={cn('h-11 w-full truncate rounded-md border px-2 text-left text-xs font-medium', SLOT_TONE[slot.reservation.status])}>{slot.reservation.customer_name}<span className="block truncate text-[10px] opacity-75">{labelize(slot.reservation.status)}</span></button></td>;
                }
                return (
                  <td key={c.id}>
                    <button disabled={!slot.available || !onBook} onClick={() => onBook?.({ date, court_id: c.id, start_time: t })}
                      className={cn('h-11 w-full rounded-md border border-dashed text-xs', slot.available ? 'border-emerald-300 bg-emerald-50/60 text-emerald-700 hover:bg-emerald-100' : 'border-zinc-200 bg-zinc-50 text-zinc-300')}>
                      {slot.available ? 'Available' : '—'}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeekView({ start, onOpen, onDay }: { start: string; onOpen: (id: string) => void; onDay: (d: string) => void }) {
  const end = addDays(start, 6);
  const list = useQuery({ queryKey: ['reservations', 'range', start, end], queryFn: () => api.get('/reservations', { from: start, to: end }) });
  if (list.isLoading) return <LoadingBlock />;
  return (
    <div className="grid gap-2 overflow-x-auto p-3 md:grid-cols-7">
      {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
        const rows = (list.data ?? []).filter((r: any) => r.date === d && !['cancelled', 'no_show'].includes(r.status));
        return (
          <div key={d} className={cn('min-h-40 rounded-lg border p-2', d === today() ? 'border-brand-400 bg-brand-50/40' : 'border-zinc-200')}>
            <button onClick={() => onDay(d)} className="mb-2 block w-full text-left"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{dayjs(d).format('ddd')}</span><span className="block text-lg font-bold leading-none text-zinc-900">{dayjs(d).format('D')}</span></button>
            <div className="space-y-1">
              {rows.map((r: any) => (
                <button key={r.id} onClick={() => onOpen(r.id)} className={cn('block w-full rounded border px-1.5 py-1 text-left text-[11px] leading-tight', SLOT_TONE[r.status] ?? 'border-emerald-300 bg-emerald-50 text-emerald-900')}>
                  <b>{fmtTime(r.start_time)}</b> {r.court_name}<span className="block truncate">{r.customer_name}</span>
                </button>
              ))}
              {!rows.length && <p className="text-[11px] text-zinc-400">No bookings</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthView({ date, onDay }: { date: string; onDay: (d: string) => void }) {
  const first = dayjs(date).startOf('month');
  const gridStart = first.startOf('week');
  const from = first.format('YYYY-MM-DD'), to = first.endOf('month').format('YYYY-MM-DD');
  const list = useQuery({ queryKey: ['reservations', 'range', from, to], queryFn: () => api.get('/reservations', { from, to }) });
  if (list.isLoading) return <LoadingBlock />;
  const count = new Map<string, { n: number; hours: number }>();
  for (const r of list.data ?? []) {
    if (['cancelled', 'no_show'].includes(r.status)) continue;
    const c = count.get(r.date) ?? { n: 0, hours: 0 };
    count.set(r.date, { n: c.n + 1, hours: c.hours + Number(r.duration_hours) });
  }
  return (
    <div className="p-3">
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{DAYS.map((d) => <div key={d} className="py-1">{d.slice(0, 3)}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 42 }, (_, i) => gridStart.add(i, 'day')).map((d) => {
          const key = d.format('YYYY-MM-DD');
          const c = count.get(key);
          const inMonth = d.month() === first.month();
          return (
            <button key={key} onClick={() => onDay(key)} className={cn('flex min-h-20 flex-col rounded-lg border p-1.5 text-left hover:border-brand-400', inMonth ? 'border-zinc-200 bg-white' : 'border-transparent bg-zinc-50 text-zinc-400', key === today() && 'border-brand-500 ring-1 ring-brand-500')}>
              <span className="text-sm font-semibold">{d.date()}</span>
              {c && inMonth && <span className="mt-auto rounded bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">{c.n} booking{c.n > 1 ? 's' : ''}<span className="hidden font-normal sm:inline"> · {c.hours}h</span></span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
function ReservationList({ onOpen }: { onOpen: (id: string) => void }) {
  const [from, setFrom] = React.useState(() => addDays(today(), -7));
  const [to, setTo] = React.useState(() => addDays(today(), 30));
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');
  const list = useQuery({ queryKey: ['reservations', 'list', from, to, status, q], queryFn: () => api.get('/reservations', { from, to, status, q, order: 'desc' }) });
  return (
    <Card>
      <CardHeader title="Reservations" description={`${list.data?.length ?? 0} record(s)`} action={
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
            <option value="">All statuses</option>
            {['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'].map((s) => <option key={s} value={s}>{labelize(s)}</option>)}
          </Select>
          <SearchInput value={q} onChange={setQ} placeholder="Customer or reference…" />
        </div>} />
      <DataTable rows={list.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => onOpen(r.id)} empty="No reservations in this range"
        columns={[
          { key: 'reference_no', label: 'Reference', className: 'font-medium text-zinc-900' },
          { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) },
          { key: 'time', label: 'Time', render: (r: any) => `${fmtTime(r.start_time)} – ${fmtTime(r.end_time)}` },
          { key: 'court_name', label: 'Court' },
          { key: 'customer_name', label: 'Customer', render: (r: any) => <>{r.customer_name}{r.is_walk_in && <Badge className="ml-2">Walk-in</Badge>}</> },
          { key: 'total_amount', label: 'Total', align: 'right', render: (r: any) => peso(r.total_amount) },
          { key: 'balance', label: 'Balance', align: 'right', render: (r: any) => <span className={Number(r.balance) > 0 ? 'font-semibold text-amber-700' : ''}>{peso(r.balance)}</span> },
          { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        ]} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Booking dialog
// ---------------------------------------------------------------------------
function BookingDialog({ prefill, onClose, onCreated }: { prefill: Prefill; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const settings = useSettings();
  const [date, setDate] = React.useState(prefill.date);
  const [courtId, setCourtId] = React.useState(prefill.court_id ?? '');
  const [time, setTime] = React.useState(prefill.start_time ?? '');
  const [duration, setDuration] = React.useState('1');
  const [player, setPlayer] = React.useState<PlayerLite | null>(null);
  const [name, setName] = React.useState('');
  const [contact, setContact] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [payMode, setPayMode] = React.useState<'later' | 'now'>('later');
  const [payments, setPayments] = React.useState<PaymentLine[]>([{ method: 'cash', amount: '', reference_no: '' }]);
  const [key] = React.useState(newKey);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const avail = useQuery({ queryKey: ['availability', date, duration], queryFn: () => api.get('/reservations/availability', { date, duration }) });
  const court = avail.data?.courts.find((c: any) => c.id === courtId);
  const slots = court?.slots.filter((s: any) => s.available) ?? [];
  const quote = useQuery({
    queryKey: ['quote', courtId, date, time, duration, player?.id],
    queryFn: () => api.post('/reservations/quote', { court_id: courtId, date, start_time: time, duration_hours: duration, player_id: player?.id ?? null }),
    enabled: !!courtId && !!time,
  });
  const tender = tenderSummary(payments, quote.data?.total ?? 0);
  const canPay = can('pos.use');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const paying = payMode === 'now' && cleanPayments(payments).length > 0;
      const res = await api.post('/reservations', {
        court_id: courtId, date, start_time: time, duration_hours: Number(duration), player_id: player?.id ?? null,
        customer_name: player ? null : name.trim() || null, customer_contact: contact.trim() || null, notes: notes.trim() || null,
        is_walk_in: date === today() && !player,
        ...(paying ? { payments: cleanPayments(payments), idempotency_key: key } : {}),
      });
      toast.success(`Reservation ${res.reservation.reference_no} ${paying ? 'booked and paid' : 'saved as pending'}`);
      qc.invalidateQueries();
      onCreated(res.reservation.id);
    } catch (e) {
      setError(errMsg(e));
      qc.invalidateQueries({ queryKey: ['availability'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New Reservation" description="Slots are re-checked by the server when you save, so two people can never book the same court and time." size="lg"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!quote.data || (!player && !name.trim()) || (payMode === 'now' && tender.nonCashOver)}>{payMode === 'now' && tender.paid > 0 ? `Book & collect ${peso(tender.paid / 100)}` : 'Save reservation'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="1. Date"><Input type="date" min={today()} value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} /></Field>
          <Field label="Duration">
            <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
              {[1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12].filter((h) => settings.data?.booking_slot_minutes === 30 || Number.isInteger(h)).map((h) => <option key={h} value={h}>{h} hour{h > 1 ? 's' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Court">
            <Select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              <option value="">Select…</option>
              {avail.data?.courts.map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'available' ? ` (${labelize(c.status)})` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Start time">
            <Select value={slots.some((s: any) => s.time === time) ? time : ''} onChange={(e) => setTime(e.target.value)} disabled={!courtId}>
              <option value="">{courtId ? (slots.length ? 'Select…' : 'No free slots') : '—'}</option>
              {slots.map((s: any) => <option key={s.time} value={s.time}>{fmtTime(s.time)}</option>)}
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600">2. Customer</p>
          <PlayerPicker value={player} onChange={setPlayer} />
          {!player && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Walk-in / guest name *" />
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact number" />
            </div>
          )}
        </div>

        <div className="rounded-xl bg-zinc-50 p-4">
          {quote.error ? <p className="text-sm text-red-700">{errMsg(quote.error)}</p> : !quote.data ? <p className="text-sm text-zinc-500">Choose a court and start time to see the price.</p> : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-zinc-500">Ends at</dt><dd className="font-semibold">{fmtTime(quote.data.end_time)}</dd></div>
              <div><dt className="text-xs text-zinc-500">{labelize(quote.data.rate_type)} rate</dt><dd className="font-semibold">{peso(quote.data.rate_amount)}</dd></div>
              <div><dt className="text-xs text-zinc-500">Member discount{quote.data.membership ? ` (${quote.data.membership.plan_name})` : ''}</dt><dd className="font-semibold text-emerald-700">−{peso(quote.data.discount_amount)}</dd></div>
              <div><dt className="text-xs text-zinc-500">Total</dt><dd className="text-lg font-extrabold text-brand-700">{peso(quote.data.total)}</dd></div>
            </dl>
          )}
        </div>

        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="min-h-14" /></Field>

        {canPay && quote.data && (
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600">3. Payment</p>
            <div className="mb-2 flex gap-2">
              {([['later', 'Pay later (save as pending)'], ['now', 'Take deposit or full payment now']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setPayMode(v)} className={cn('flex-1 rounded-lg border px-3 py-2 text-sm font-medium', payMode === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-50')}>{l}</button>
              ))}
            </div>
            {payMode === 'now' && <PaymentFields lines={payments} onChange={setPayments} due={quote.data.total} />}
          </div>
        )}
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail + actions
// ---------------------------------------------------------------------------
function ReservationDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const settings = useSettings();
  const navigate = useNavigate();
  const ref = React.useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = React.useState<null | 'cancel' | 'reschedule'>(null);
  const [receipt, setReceipt] = React.useState<string | null>(null);
  const res = useQuery({ queryKey: ['reservation', id], queryFn: () => api.get(`/reservations/${id}`), enabled: !!id });
  const courts = useQuery({ queryKey: ['courts'], queryFn: () => api.get('/courts'), enabled: dialog === 'reschedule' });
  const done = () => qc.invalidateQueries();
  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/reservations/${id}/status`, { status }),
    onSuccess: (r) => { toast.success(`Marked ${labelize(r.status)}`); done(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const r = res.data;
  const manage = can('reservations.manage');
  const next: Record<string, [string, string][]> = {
    pending: [['confirmed', 'Confirm'], ['checked_in', 'Check In'], ['no_show', 'No Show']],
    confirmed: [['checked_in', 'Check In'], ['no_show', 'No Show']],
    checked_in: [['in_progress', 'Start Play'], ['completed', 'Check Out']],
    in_progress: [['completed', 'Check Out']],
  };
  return (
    <>
      <Dialog open={!!id} onOpenChange={(o) => !o && onClose()} title={r ? `Reservation ${r.reference_no}` : 'Reservation'} size="lg"
        footer={r && (
          <>
            <Button variant="outline" onClick={() => printElement(ref.current, 80)}><Printer />Booking slip</Button>
            {r.transaction_id && <Button variant="outline" onClick={() => setReceipt(r.transaction_id)}>Receipt</Button>}
            {manage && ['pending', 'confirmed'].includes(r.status) && <Button variant="outline" onClick={() => setDialog('reschedule')}><Clock />Reschedule</Button>}
            {manage && ['pending', 'confirmed', 'checked_in'].includes(r.status) && <Button variant="outline" className="text-red-700" onClick={() => setDialog('cancel')}>Cancel booking</Button>}
            {can('pos.use') && !r.transaction_id && Number(r.total_amount) > 0 && !['cancelled', 'no_show'].includes(r.status) && <Button variant="dark" onClick={() => navigate(`/pos?reservation=${r.id}`)}>Take payment</Button>}
            {can('pos.use') && r.transaction_id && Number(r.balance) > 0 && !['cancelled', 'no_show'].includes(r.status) && <Button variant="dark" onClick={() => navigate(`/transactions?open=${r.transaction_id}`)}>Collect balance</Button>}
            {manage && (next[r.status] ?? []).map(([s, label]) => <Button key={s} variant={s === 'no_show' ? 'outline' : 'primary'} loading={setStatus.isPending && setStatus.variables === s} onClick={() => setStatus.mutate(s)}>{label}</Button>)}
          </>
        )}>
        {!r ? <LoadingBlock /> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={r.status} />{r.is_walk_in && <Badge>Walk-in</Badge>}{Number(r.balance) > 0 && !['cancelled', 'no_show'].includes(r.status) && <Badge tone="amber">Balance {peso(r.balance)}</Badge>}</div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {[
                ['Customer', <>{r.customer_name}{r.player_no ? ` (${r.player_no})` : ''}</>], ['Contact', r.customer_contact ?? '—'], ['Court', r.court_name],
                ['Date', fmtDate(r.date)], ['Time', `${fmtTime(r.start_time)} – ${fmtTime(r.end_time)}`], ['Duration', `${Number(r.duration_hours)} hour(s)`],
                [`Court fee (${labelize(r.rate_type)})`, peso(r.rate_amount)], ['Discount', `−${peso(r.discount_amount)}`], ['Total', <b>{peso(r.total_amount)}</b>],
                ['Paid', peso(r.amount_paid)], ['Created by', `${r.created_by_name ?? '—'} · ${fmtDateTime(r.created_at)}`], ['Last modified by', `${r.updated_by_name ?? '—'} · ${fmtDateTime(r.updated_at)}`],
              ].map(([l, v], i) => <div key={i}><dt className="text-xs text-zinc-500">{l}</dt><dd className="font-medium text-zinc-900">{v}</dd></div>)}
            </dl>
            {r.notes && <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">{r.notes}</p>}
            {r.cancel_reason && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">Cancelled: {r.cancel_reason}{Number(r.amount_paid) > 0 && <> — {peso(r.amount_paid)} was paid. Process the refund from the transaction (manager approval required).</>}</p>}
            {/* printable booking confirmation */}
            <div className="hidden"><div ref={ref}>
              <div className="center"><div className="big">{settings.data?.business_name}</div><div>{settings.data?.business_address}</div><div>{settings.data?.business_contact}</div><div className="bold">BOOKING CONFIRMATION</div></div><hr />
              <div className="row"><span>Reference</span><span className="bold">{r.reference_no}</span></div>
              <div className="row"><span>Customer</span><span>{r.customer_name}</span></div>
              <div className="row"><span>Court</span><span>{r.court_name}</span></div>
              <div className="row"><span>Date</span><span>{fmtDate(r.date)}</span></div>
              <div className="row"><span>Time</span><span>{fmtTime(r.start_time)} - {fmtTime(r.end_time)}</span></div>
              <div className="row"><span>Status</span><span>{labelize(r.status)}</span></div><hr />
              <div className="row"><span>Court fee</span><span>{peso(r.rate_amount)}</span></div>
              <div className="row"><span>Discount</span><span>-{peso(r.discount_amount)}</span></div>
              <div className="row bold"><span>Total</span><span>{peso(r.total_amount)}</span></div>
              <div className="row"><span>Paid</span><span>{peso(r.amount_paid)}</span></div>
              <div className="row bold"><span>Balance</span><span>{peso(r.balance)}</span></div><hr />
              <div className="center">Please arrive 10 minutes early.<br />Present this reference at the front desk.</div>
            </div></div>
          </div>
        )}
      </Dialog>

      <FormDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} title="Cancel Reservation" size="sm" submitLabel="Cancel reservation"
        description={r && Number(r.amount_paid) > 0 ? `${peso(r.amount_paid)} has been paid. Cancelling does not refund it automatically.` : 'The time slot is released immediately.'}
        fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
        onSubmit={async (v) => { await api.post(`/reservations/${id}/cancel`, v); toast.success('Reservation cancelled'); done(); }} />

      {r && (
        <FormDialog open={dialog === 'reschedule'} onOpenChange={(o) => !o && setDialog(null)} title="Reschedule Reservation" submitLabel="Reschedule"
          description={r.transaction_id ? 'Already billed: the duration and the price charged stay the same.' : 'The price is recalculated for the new date and time.'}
          initial={{ court_id: r.court_id, date: r.date, start_time: r.start_time, duration_hours: Number(r.duration_hours) }}
          fields={[
            { name: 'court_id', label: 'Court', type: 'select', required: true, options: (courts.data ?? []).filter((c: any) => c.is_active).map((c: any) => ({ value: c.id, label: c.name })) },
            { name: 'date', label: 'Date', type: 'date', required: true },
            { name: 'start_time', label: 'Start time', type: 'time', required: true },
            { name: 'duration_hours', label: 'Duration (hours)', type: 'number', required: true },
          ]}
          onSubmit={async (v) => { await api.put(`/reservations/${id}/reschedule`, v); toast.success('Reservation rescheduled'); done(); }} />
      )}
      <ReceiptDialog transactionId={receipt} onClose={() => setReceipt(null)} reprint />
    </>
  );
}

// ---------------------------------------------------------------------------
// Courts setup
// ---------------------------------------------------------------------------
function Courts() {
  const { can } = useAuth();
  const [hoursFor, setHoursFor] = React.useState<any | null>(null);
  return (
    <>
      <CrudSection title="Courts" description="Add, edit, activate or deactivate courts. Deactivated courts cannot be booked." endpoint="/courts" queryKey="courts" noun="Court" canManage={can('courts.manage')} deleteLabel="Deactivate" deletable={(r: any) => r.is_active}
        rowActions={(row: any) => <Button variant="outline" size="sm" onClick={() => setHoursFor(row)}><Clock />Hours</Button>}
        columns={[
          { key: 'code', label: 'Court ID', className: 'font-medium text-zinc-900' },
          { key: 'name', label: 'Name' },
          { key: 'court_type', label: 'Type', render: (r: any) => labelize(r.court_type) },
          { key: 'description', label: 'Description' },
          { key: 'hourly_rate', label: 'Fallback hourly rate', align: 'right', render: (r: any) => peso(r.hourly_rate) },
          { key: 'status', label: 'Maintenance status', render: (r: any) => <Badge tone={STATUS_TONE[r.status]}>{r.status === 'maintenance' ? 'Under Maintenance' : labelize(r.status)}</Badge> },
          { key: 'is_active', label: 'Operating', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
        ]}
        fields={[
          { name: 'code', label: 'Court ID / code', required: true },
          { name: 'name', label: 'Court name', required: true },
          { name: 'court_type', label: 'Court type', type: 'select', required: true, default: 'indoor', options: [{ value: 'indoor', label: 'Indoor' }, { value: 'outdoor', label: 'Outdoor' }, { value: 'covered', label: 'Covered' }] },
          { name: 'hourly_rate', label: 'Fallback hourly rate (₱)', type: 'money', required: true, hint: 'Used only when no price-list row applies.' },
          { name: 'status', label: 'Maintenance status', type: 'select', required: true, default: 'available', options: [{ value: 'available', label: 'Available' }, { value: 'maintenance', label: 'Under Maintenance' }, { value: 'closed', label: 'Closed' }] },
          { name: 'sort_order', label: 'Display order', type: 'number', default: 0 },
          { name: 'is_active', label: 'Operating status', type: 'checkbox', default: true, placeholder: 'Active (can be booked)' },
          { name: 'description', label: 'Description', type: 'textarea' },
        ]} />
      {hoursFor && <HoursDialog court={hoursFor} onClose={() => setHoursFor(null)} readOnly={!can('courts.manage')} />}
    </>
  );
}

function HoursDialog({ court, onClose, readOnly }: { court: any; onClose: () => void; readOnly: boolean }) {
  const hours = useQuery({ queryKey: ['court-hours', court.id], queryFn: () => api.get(`/courts/${court.id}/hours`) });
  const [rows, setRows] = React.useState<any[] | null>(null);
  React.useEffect(() => { if (hours.data) setRows(hours.data.map((h: any) => ({ ...h, open_time: h.open_time.slice(0, 5), close_time: h.close_time.slice(0, 5) }))); }, [hours.data]);
  const save = useMutation({
    mutationFn: () => api.put(`/courts/${court.id}/hours`, rows),
    onSuccess: () => { toast.success('Operating hours saved'); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const set = (i: number, patch: any) => setRows((r) => r!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${court.name} — Operating Schedule`} size="md"
      footer={<><Button variant="outline" onClick={onClose}>Close</Button>{!readOnly && <Button loading={save.isPending} onClick={() => save.mutate()}>Save schedule</Button>}</>}>
      {!rows ? <LoadingBlock /> : (
        <div className="space-y-2">
          {rows.map((h, i) => (
            <div key={h.day_of_week} className="grid grid-cols-[6.5rem_1fr_1fr_auto] items-center gap-2">
              <span className="text-sm font-medium text-zinc-800">{DAYS[h.day_of_week]}</span>
              <Input type="time" value={h.open_time} disabled={h.is_closed || readOnly} onChange={(e) => set(i, { open_time: e.target.value })} aria-label="Opens" />
              <Input type="time" value={h.close_time} disabled={h.is_closed || readOnly} onChange={(e) => set(i, { close_time: e.target.value })} aria-label="Closes" />
              <label className="flex items-center gap-1.5 text-xs text-zinc-600"><input type="checkbox" className="size-4 accent-brand-600" checked={h.is_closed} disabled={readOnly} onChange={(e) => set(i, { is_closed: e.target.checked })} />Closed</label>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
