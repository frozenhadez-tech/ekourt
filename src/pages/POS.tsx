import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Minus, PackageSearch, Plus, ShoppingCart, Trash2, UserPlus } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FormDialog } from '@/components/forms';
import { ApproverFields, cleanPayments, PaymentFields, PlayerPicker, ReceiptDialog, tenderSummary, type Approver, type PaymentLine, type PlayerLite } from '@/components/pos';
import { ShiftBar, useCurrentShift } from '@/components/shifts';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, SearchInput, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { ApiError, api, errMsg, newKey } from '@/lib/api';
import { useSettings } from '@/lib/auth';
import { cn, fmtDate, fmtTime, labelize, peso, today } from '@/lib/format';

interface CartItem {
  key: string;
  item_type: 'court' | 'product' | 'service' | 'equipment' | 'membership' | 'charge';
  label: string;
  sub?: string;
  quantity: number;
  fixedQty?: boolean;
  payload: Record<string, unknown>;
}

const DURATIONS = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semi_annual', 'Semi-Annual'], ['annual', 'Annual']] as const;
const tile = 'flex min-h-24 flex-col justify-between rounded-xl border border-zinc-200 bg-white p-3 text-left shadow-card transition hover:border-brand-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50';

export default function POS() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const settings = useSettings();
  const shift = useCurrentShift();

  const [player, setPlayer] = React.useState<PlayerLite | null>(null);
  const [customerName, setCustomerName] = React.useState('');
  const [cart, setCart] = React.useState<CartItem[]>([]);
  const [discountId, setDiscountId] = React.useState('');
  const [promoCode, setPromoCode] = React.useState('');
  const [idNumber, setIdNumber] = React.useState('');
  const [payments, setPayments] = React.useState<PaymentLine[]>([{ method: 'cash', amount: '', reference_no: '' }]);
  const [allowPartial, setAllowPartial] = React.useState(false);
  const [approver, setApprover] = React.useState<Approver>({ email: '', password: '' });
  const [needApproval, setNeedApproval] = React.useState(false);
  const [idemKey, setIdemKey] = React.useState(newKey);
  const [busy, setBusy] = React.useState(false);
  const [receipt, setReceipt] = React.useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const products = useQuery({ queryKey: ['products'], queryFn: () => api.get('/products') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get('/services') });
  const equipment = useQuery({ queryKey: ['equipment'], queryFn: () => api.get('/equipment') });
  const plans = useQuery({ queryKey: ['membership-plans'], queryFn: () => api.get('/membership-plans') });
  const discounts = useQuery({ queryKey: ['discounts'], queryFn: () => api.get('/discounts') });
  const unbilled = useQuery({ queryKey: ['reservations', 'unbilled'], queryFn: () => api.get('/reservations', { unbilled: true }) });

  const add = (item: Omit<CartItem, 'key' | 'quantity'> & { quantity?: number; mergeKey?: string }) => {
    setCart((c) => {
      const existing = item.mergeKey ? c.find((x) => x.key === item.mergeKey) : undefined;
      if (existing && !existing.fixedQty) return c.map((x) => (x === existing ? { ...x, quantity: x.quantity + 1 } : x));
      if (item.item_type === 'court' && c.some((x) => x.item_type === 'court')) { toast.error('Only one court booking per transaction. Complete this sale first.'); return c; }
      if (item.item_type === 'membership' && c.some((x) => x.item_type === 'membership')) { toast.error('Only one membership per transaction.'); return c; }
      return [...c, { ...item, key: item.mergeKey ?? newKey(), quantity: item.quantity ?? 1 }];
    });
  };
  const setQty = (key: string, q: number) => setCart((c) => (q <= 0 ? c.filter((x) => x.key !== key) : c.map((x) => (x.key === key ? { ...x, quantity: q } : x))));

  // Deep link from Reservations: /pos?reservation=<id> puts that booking in the cart.
  React.useEffect(() => {
    const rid = params.get('reservation');
    if (!rid || !unbilled.data) return;
    const r = unbilled.data.find((x: any) => x.id === rid);
    if (r) addReservation(r);
    else toast.error('That reservation is already billed or no longer payable.');
    setParams({}, { replace: true });
  }, [params, unbilled.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const addReservation = (r: any) => {
    if (r.player_id) setPlayer({ id: r.player_id, player_no: r.player_no, full_name: r.player_name });
    else setCustomerName(r.customer_name);
    add({ item_type: 'court', mergeKey: `res-${r.id}`, fixedQty: true, label: `${r.court_name} · ${r.reference_no}`, sub: `${fmtDate(r.date)} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)}`, payload: { item_type: 'court', ref_id: r.id } });
    setAllowPartial(true);
  };

  const discountPayload = discountId || promoCode.trim() ? { discount_id: discountId || null, code: discountId ? null : promoCode.trim(), id_number: idNumber.trim() || null } : null;
  const body = React.useMemo(() => ({
    player_id: player?.id ?? null,
    customer_name: player ? null : customerName.trim() || null,
    items: cart.map((c) => ({ ...c.payload, quantity: c.quantity })),
    discount: discountPayload,
  }), [player, customerName, cart, discountId, promoCode, idNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-priced preview: the till never computes money itself.
  const previewKey = JSON.stringify(body);
  const deferredKey = React.useDeferredValue(previewKey);
  const preview = useQuery({
    queryKey: ['pos-preview', deferredKey],
    queryFn: () => api.post('/transactions/checkout', { ...JSON.parse(deferredKey), idempotency_key: 'preview-00000000', preview: true, payments: [] }),
    enabled: cart.length > 0,
    retry: false,
    staleTime: 5_000,
  });
  const total = preview.data?.total ?? '0.00';
  const tender = tenderSummary(payments, total);
  const selectedDiscount = discounts.data?.find((d: any) => d.id === discountId);
  const statutory = selectedDiscount && ['senior', 'pwd'].includes(selectedDiscount.discount_type);

  const reset = () => {
    setCart([]); setPlayer(null); setCustomerName(''); setDiscountId(''); setPromoCode(''); setIdNumber('');
    setPayments([{ method: 'cash', amount: '', reference_no: '' }]); setAllowPartial(false); setNeedApproval(false); setApprover({ email: '', password: '' }); setIdemKey(newKey());
  };

  const complete = async () => {
    setBusy(true);
    try {
      const trx = await api.post('/transactions/checkout', {
        ...body, idempotency_key: idemKey, payments: cleanPayments(payments), allow_partial: allowPartial,
        approver: needApproval && approver.email ? approver : null,
      });
      toast.success(`${trx.transaction_no} completed`, { description: trx.discount_note ?? undefined });
      setReceipt(trx.id);
      reset();
      qc.invalidateQueries();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') { setNeedApproval(true); toast.warning('This discount needs manager approval. Ask a manager to sign in below.'); }
      else toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const noShift = settings.data?.require_open_shift && !shift.data;
  const canComplete = cart.length > 0 && !preview.error && !!preview.data && !noShift && !tender.nonCashOver && (tender.balance === 0 || allowPartial);
  const term = search.trim().toLowerCase();
  const match = (s: string) => !term || s.toLowerCase().includes(term);
  const member = player?.membership_status === 'active';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-3">
      <ShiftBar />
      <div className="grid items-start gap-3 xl:grid-cols-[1fr_27rem]">
        {/* LEFT: customer + catalog */}
        <div className="space-y-3">
          <Card className="p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <PlayerPicker value={player} onChange={setPlayer} />
              <Button variant="outline" onClick={() => setRegisterOpen(true)}><UserPlus />Register Player</Button>
            </div>
            {!player && <Input className="mt-2" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in customer name (optional)" />}
          </Card>

          <Card className="p-3">
            <Tabs defaultValue="court">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList className="mb-0 border-b-0">
                  <TabsTrigger value="court">Court</TabsTrigger>
                  <TabsTrigger value="products">Products</TabsTrigger>
                  <TabsTrigger value="services">Services</TabsTrigger>
                  <TabsTrigger value="rentals">Rentals</TabsTrigger>
                  <TabsTrigger value="membership">Membership</TabsTrigger>
                  <TabsTrigger value="charge">Other Charge</TabsTrigger>
                </TabsList>
                <SearchInput value={search} onChange={setSearch} placeholder="Filter catalog…" className="sm:w-52" />
              </div>
              <div className="mt-3 border-t border-zinc-100 pt-3">
                <TabsContent value="court">
                  <WalkInCourt onAdd={(b, label, sub) => add({ item_type: 'court', fixedQty: true, label, sub, payload: { item_type: 'court', booking: b } })} playerId={player?.id} />
                  <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Unpaid reservations</p>
                  {unbilled.isLoading ? <LoadingBlock /> : !unbilled.data?.filter((r: any) => match(r.customer_name + r.reference_no)).length ? <EmptyState title="No unpaid reservations" hint="Bookings saved without payment appear here." /> : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {unbilled.data.filter((r: any) => match(r.customer_name + r.reference_no)).map((r: any) => (
                        <button key={r.id} className={tile} onClick={() => addReservation(r)}>
                          <span><span className="block text-sm font-semibold text-zinc-900">{r.customer_name}</span><span className="block text-xs text-zinc-500">{r.reference_no} · {r.court_name}</span></span>
                          <span className="mt-2 flex items-end justify-between"><span className="text-xs text-zinc-600">{fmtDate(r.date)} {fmtTime(r.start_time)}</span><span className="text-sm font-bold text-brand-700">{peso(r.total_amount)}</span></span>
                        </button>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="products">
                  {products.isLoading ? <LoadingBlock /> : (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-4">
                      {products.data.filter((p: any) => p.status === 'active' && match(p.name + p.code + (p.category_name ?? ''))).map((p: any) => {
                        const inCart = cart.find((c) => c.key === `prd-${p.id}`)?.quantity ?? 0;
                        return (
                          <button key={p.id} className={tile} disabled={p.stock_qty - inCart <= 0}
                            onClick={() => add({ item_type: 'product', mergeKey: `prd-${p.id}`, label: p.name, sub: `${peso(p.selling_price)} each`, payload: { item_type: 'product', ref_id: p.id } })}>
                            <span><span className="block text-sm font-semibold leading-tight text-zinc-900">{p.name}</span><span className="block text-xs text-zinc-500">{p.category_name ?? p.code}</span></span>
                            <span className="mt-2 flex items-end justify-between"><span className={cn('text-xs', p.stock_qty <= p.min_stock ? 'font-semibold text-red-600' : 'text-zinc-500')}>{p.stock_qty === 0 ? 'Out of stock' : `${p.stock_qty} left`}</span><span className="text-sm font-bold text-brand-700">{peso(p.selling_price)}</span></span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="services">
                  {services.isLoading ? <LoadingBlock /> : (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                      {services.data.filter((s: any) => s.is_active && match(s.name + s.category)).map((s: any) => (
                        <button key={s.id} className={tile} onClick={() => add({ item_type: 'service', mergeKey: `svc-${s.id}`, label: s.name, sub: `${peso(s.price)} ${labelize(s.charge_method).toLowerCase()}`, payload: { item_type: 'service', ref_id: s.id } })}>
                          <span><span className="block text-sm font-semibold leading-tight text-zinc-900">{s.name}</span><span className="block text-xs text-zinc-500">{labelize(s.category)} · {labelize(s.charge_method)}</span></span>
                          <span className="mt-2 text-right text-sm font-bold text-brand-700">{peso(s.price)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="rentals">
                  {equipment.isLoading ? <LoadingBlock /> : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {equipment.data.filter((e: any) => e.is_active && match(e.name)).map((e: any) => (
                        <RentalTile key={e.id} e={e} member={!!member} onAdd={(hours, free) => add({
                          item_type: 'equipment', label: `${e.name} rental`, sub: free ? 'Member free rental' : `${peso(e.rental_rate)} ${labelize(e.charge_method).toLowerCase()}${hours ? ` × ${hours} hr` : ''}`, fixedQty: free,
                          payload: { item_type: 'equipment', ref_id: e.id, hours: hours ?? undefined, use_entitlement: free },
                        })} />
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="membership">
                  {!player ? <EmptyState title="Select a registered player first" hint="Memberships are tied to a player record. Search or register the player above." /> : plans.isLoading ? <LoadingBlock /> : (
                    <div className="grid gap-2 md:grid-cols-3">
                      {plans.data.filter((p: any) => p.is_active).map((p: any) => <PlanTile key={p.id} plan={p} months={settings.data?.duration_months ?? {}} hasMembership={!!member}
                        onAdd={(duration, action) => add({ item_type: 'membership', fixedQty: true, label: `${p.name}`, sub: `${labelize(duration)} · ${labelize(action)}`, payload: { item_type: 'membership', plan_id: p.id, duration, action } })} />)}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="charge"><OtherCharge onAdd={(description, amount) => add({ item_type: 'charge', label: description, sub: 'Additional charge', payload: { item_type: 'charge', description, amount } })} /></TabsContent>
              </div>
            </Tabs>
          </Card>
        </div>

        {/* RIGHT: current order */}
        <Card className="flex flex-col xl:sticky xl:top-0">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold"><ShoppingCart className="size-4 text-brand-600" />Current Order</p>
            {cart.length > 0 && <button onClick={reset} className="text-xs font-semibold text-red-600 hover:underline">Clear</button>}
          </div>
          <div className="max-h-[32vh] min-h-24 overflow-y-auto">
            {!cart.length ? <EmptyState title="No items yet" hint="Pick items from the catalog on the left." /> : cart.map((c, i) => {
              const line = preview.data?.lines?.[i];
              return (
                <div key={c.key} className="flex items-center gap-2 border-b border-zinc-50 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">{c.label}</p>
                    <p className="truncate text-xs text-zinc-500">{c.sub}{line && Number(line.discount_amount) > 0 ? <span className="font-medium text-emerald-700"> · −{peso(line.discount_amount)}</span> : null}</p>
                  </div>
                  {c.fixedQty ? <span className="w-8 text-center text-sm text-zinc-500">×{c.quantity}</span> : (
                    <div className="flex items-center rounded-lg border border-zinc-200">
                      <button aria-label="Decrease" onClick={() => setQty(c.key, c.quantity - 1)} className="p-1.5 text-zinc-600 hover:bg-zinc-100"><Minus className="size-3.5" /></button>
                      <span className="w-7 text-center text-sm font-semibold">{c.quantity}</span>
                      <button aria-label="Increase" onClick={() => setQty(c.key, c.quantity + 1)} className="p-1.5 text-zinc-600 hover:bg-zinc-100"><Plus className="size-3.5" /></button>
                    </div>
                  )}
                  <span className="w-20 text-right text-sm font-semibold text-zinc-900">{line ? peso(line.line_total) : '…'}</span>
                  <button aria-label="Remove item" onClick={() => setQty(c.key, 0)} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="size-4" /></button>
                </div>
              );
            })}
          </div>

          <div className="space-y-3 border-t border-zinc-100 p-4">
            <div className="grid grid-cols-2 gap-2">
              <Select value={discountId} onChange={(e) => { setDiscountId(e.target.value); setPromoCode(''); setNeedApproval(false); }} aria-label="Discount">
                <option value="">No discount</option>
                {discounts.data?.filter((d: any) => d.is_active).map((d: any) => <option key={d.id} value={d.id}>{d.name}{d.requires_approval ? ' (approval)' : ''}</option>)}
              </Select>
              {statutory
                ? <Input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="SC / PWD ID number *" />
                : <Input value={promoCode} onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setDiscountId(''); }} placeholder="or promo code" disabled={!!discountId} />}
            </div>
            {needApproval && <ApproverFields value={approver} onChange={setApprover} reason="restricted discount" />}

            {preview.error && cart.length > 0 && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{errMsg(preview.error)}</div>}
            {preview.data?.discount_note && <p className="text-xs text-amber-700">{preview.data.discount_note}</p>}

            <dl className="space-y-1 text-sm">
              <div className="flex justify-between text-zinc-600"><dt>Subtotal</dt><dd>{peso(preview.data?.subtotal)}</dd></div>
              <div className="flex justify-between text-emerald-700"><dt>Discount{preview.data?.discount_label ? ` (${preview.data.discount_label})` : ''}</dt><dd>−{peso(preview.data?.discount_total)}</dd></div>
              {settings.data?.vat_registered && <div className="flex justify-between text-xs text-zinc-500"><dt>VAT included</dt><dd>{peso(preview.data?.vat_amount)}</dd></div>}
              <div className="flex items-baseline justify-between border-t border-dashed border-zinc-200 pt-2"><dt className="text-base font-bold text-zinc-900">Total</dt><dd className="text-2xl font-extrabold tracking-tight text-brand-700">{preview.isFetching && !preview.data ? '…' : peso(total)}</dd></div>
            </dl>

            <PaymentFields lines={payments} onChange={setPayments} due={total} />
            <label className="flex items-center gap-2 text-xs text-zinc-600">
              <input type="checkbox" className="size-4 accent-brand-600" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
              Accept partial payment / deposit (balance stays on the customer's account)
            </label>
            <Button size="lg" className="w-full" disabled={!canComplete} loading={busy} onClick={complete}>
              {noShift ? 'Open a shift to continue' : tender.balance > 0 && allowPartial && cart.length ? `Complete with ${peso(tender.balance / 100)} balance` : 'Complete Transaction'}
            </Button>
          </div>
        </Card>
      </div>

      <FormDialog open={registerOpen} onOpenChange={setRegisterOpen} title="Quick Player Registration" description="You can complete the full profile later in Player Management."
        fields={[
          { name: 'full_name', label: 'Full name', required: true, full: true },
          { name: 'contact_number', label: 'Contact number' },
          { name: 'email', label: 'Email', type: 'email' },
          { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] },
          { name: 'birthday', label: 'Birthday', type: 'date' },
        ]}
        onSubmit={async (v) => { const p = await api.post('/players', v); toast.success(`Registered ${p.player_no}`); setPlayer({ ...p, membership_status: 'none' }); qc.invalidateQueries({ queryKey: ['players'] }); }} />
      <ReceiptDialog transactionId={receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}

function WalkInCourt({ onAdd, playerId }: { onAdd: (booking: Record<string, unknown>, label: string, sub: string) => void; playerId?: string }) {
  const [date, setDate] = React.useState(today);
  const [duration, setDuration] = React.useState('1');
  const [courtId, setCourtId] = React.useState('');
  const [time, setTime] = React.useState('');
  const avail = useQuery({ queryKey: ['availability', date, duration], queryFn: () => api.get('/reservations/availability', { date, duration }) });
  const court = avail.data?.courts.find((c: any) => c.id === courtId);
  const slots = court?.slots.filter((s: any) => s.available) ?? [];
  const quote = useQuery({
    queryKey: ['quote', courtId, date, time, duration, playerId],
    queryFn: () => api.post('/reservations/quote', { court_id: courtId, date, start_time: time, duration_hours: duration, player_id: playerId ?? null }),
    enabled: !!courtId && !!time,
  });
  React.useEffect(() => { if (time && !slots.some((s: any) => s.time === time)) setTime(''); }, [slots, time]);
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
      <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500"><CalendarClock className="size-4" />Book a court now (walk-in or advance)</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Field label="Date"><Input type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Duration">
          <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
            {[1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12].filter((h) => avail.data?.step === 30 || Number.isInteger(h)).map((h) => <option key={h} value={h}>{h} hour{h > 1 ? 's' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Court">
          <Select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
            <option value="">Select…</option>
            {avail.data?.courts.map((c: any) => <option key={c.id} value={c.id} disabled={!c.slots.some((s: any) => s.available)}>{c.name}{c.status !== 'available' ? ` (${labelize(c.status)})` : !c.slots.some((s: any) => s.available) ? ' (full)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Start time">
          <Select value={time} onChange={(e) => setTime(e.target.value)} disabled={!courtId}>
            <option value="">{courtId ? (slots.length ? 'Select…' : 'No free slots') : '—'}</option>
            {slots.map((s: any) => <option key={s.time} value={s.time}>{fmtTime(s.time)}</option>)}
          </Select>
        </Field>
        <div className="col-span-2 flex items-end md:col-span-1">
          <Button className="w-full" disabled={!quote.data}
            onClick={() => { onAdd({ court_id: courtId, date, start_time: time, duration_hours: Number(duration) }, `${court.name} · ${duration} hr`, `${fmtDate(date)} ${fmtTime(time)}–${fmtTime(quote.data.end_time)}`); setTime(''); }}>
            <Plus />{quote.data ? peso(quote.data.total) : 'Add'}
          </Button>
        </div>
      </div>
      {quote.error && <p className="mt-2 text-xs text-red-600">{errMsg(quote.error)}</p>}
      {quote.data && <p className="mt-2 text-xs text-zinc-600">{labelize(quote.data.rate_type)} rate {peso(quote.data.rate_amount)}{Number(quote.data.discount_amount) > 0 && <> · member discount −{peso(quote.data.discount_amount)}</>} · ends {fmtTime(quote.data.end_time)}</p>}
    </div>
  );
}

function RentalTile({ e, member, onAdd }: { e: any; member: boolean; onAdd: (hours: number | null, free: boolean) => void }) {
  const [hours, setHours] = React.useState(1);
  const perHour = e.charge_method === 'per_hour';
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div><p className="text-sm font-semibold text-zinc-900">{e.name}</p><p className="text-xs text-zinc-500">{peso(e.rental_rate)} {labelize(e.charge_method).toLowerCase()}</p></div>
        <Badge tone={e.available_qty > 0 ? 'green' : 'red'}>{e.available_qty} available</Badge>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {perHour && <Select value={hours} onChange={(ev) => setHours(Number(ev.target.value))} className="h-9 w-24" aria-label="Hours">{[1, 2, 3, 4, 5, 6].map((h) => <option key={h} value={h}>{h} hr</option>)}</Select>}
        <Button size="sm" className="h-9" disabled={e.available_qty <= 0} onClick={() => onAdd(perHour ? hours : null, false)}><Plus />Add rental</Button>
        {member && e.entitlement_type && <Button size="sm" variant="outline" className="h-9" disabled={e.available_qty <= 0} onClick={() => onAdd(perHour ? hours : null, true)}>Use member free rental</Button>}
      </div>
    </div>
  );
}

function PlanTile({ plan, months, hasMembership, onAdd }: { plan: any; months: Record<string, number>; hasMembership: boolean; onAdd: (duration: string, action: string) => void }) {
  const [duration, setDuration] = React.useState('monthly');
  const [action, setAction] = React.useState(hasMembership ? 'renewal' : 'new');
  React.useEffect(() => setAction(hasMembership ? 'renewal' : 'new'), [hasMembership]);
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-3 shadow-card">
      <p className="text-sm font-bold text-zinc-900">{plan.name}</p>
      <p className="text-lg font-extrabold text-brand-700">{peso(Number(plan.monthly_price) * (months[duration] ?? 1))}<span className="text-xs font-medium text-zinc-500"> / {labelize(duration).toLowerCase()}</span></p>
      <ul className="my-2 flex-1 space-y-0.5 text-xs text-zinc-600">{plan.benefits.map((b: string) => <li key={b}>• {b}</li>)}</ul>
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={duration} onChange={(e) => setDuration(e.target.value)} className="h-9" aria-label="Duration">{DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select value={action} onChange={(e) => setAction(e.target.value)} className="h-9" aria-label="Type">
          {hasMembership ? <><option value="renewal">Renew</option><option value="upgrade">Upgrade</option><option value="downgrade">Downgrade</option></> : <><option value="new">New</option><option value="renewal">Renew (lapsed)</option></>}
        </Select>
      </div>
      <Button size="sm" className="mt-2" onClick={() => onAdd(duration, action)}><Plus />Add to order</Button>
    </div>
  );
}

function OtherCharge({ onAdd }: { onAdd: (description: string, amount: string) => void }) {
  const [description, setDescription] = React.useState('');
  const [amount, setAmount] = React.useState('');
  return (
    <form className="grid gap-2 md:grid-cols-[1fr_10rem_auto]" onSubmit={(e) => { e.preventDefault(); onAdd(description.trim(), Number(amount).toFixed(2)); setDescription(''); setAmount(''); }}>
      <Field label="Description"><Input required value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Damaged ball replacement" /></Field>
      <Field label="Amount (₱)"><Input required type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <div className="flex items-end"><Button type="submit" variant="dark"><PackageSearch />Add charge</Button></div>
    </form>
  );
}
