import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, IdCard, ShoppingCart } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { FormDialog } from '@/components/forms';
import { Badge, Button, Card, CardHeader, DataTable, LoadingBlock, PageHeader, Select, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSettings } from '@/lib/auth';
import { fmtDate, labelize, peso } from '@/lib/format';
import { CardDialog } from './Players';

export default function Memberships() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const settings = useSettings();
  const [status, setStatus] = React.useState('');
  const [action, setAction] = React.useState<{ row: any; action: 'suspend' | 'resume' | 'cancel' } | null>(null);
  const [card, setCard] = React.useState<any | null>(null);
  const days = settings.data?.membership_expiry_notice_days ?? 7;
  const list = useQuery({ queryKey: ['memberships', status], queryFn: () => api.get('/memberships', { status }) });
  const expiring = useQuery({ queryKey: ['memberships', 'expiring', days], queryFn: () => api.get('/memberships', { status: 'expiring', days }) });
  const plans = useQuery({ queryKey: ['membership-plans'], queryFn: () => api.get('/membership-plans') });
  const manage = can('memberships.manage');

  const columns = [
    { key: 'membership_no', label: 'Membership No.', className: 'font-medium text-zinc-900' },
    { key: 'player_name', label: 'Player', render: (r: any) => <>{r.player_name}<span className="block text-xs text-zinc-500">{r.player_no}</span></> },
    { key: 'plan_name', label: 'Plan', render: (r: any) => <>{r.plan_name}<span className="block text-xs text-zinc-500">{labelize(r.duration)} · {labelize(r.action)}</span></> },
    { key: 'start_date', label: 'Start', render: (r: any) => fmtDate(r.start_date) },
    { key: 'end_date', label: 'Expires', render: (r: any) => <>{fmtDate(r.end_date)}{r.effective_status === 'active' && <span className={`block text-xs ${r.days_left <= days ? 'font-semibold text-red-600' : 'text-zinc-500'}`}>{r.days_left} day(s) left</span>}</> },
    { key: 'price_paid', label: 'Paid', align: 'right' as const, render: (r: any) => peso(r.price_paid) },
    { key: 'discounts_used', label: 'Discounts used', align: 'right' as const, render: (r: any) => peso(r.discounts_used) },
    { key: 'free', label: 'Free rentals (month)', align: 'center' as const, render: (r: any) => r.free_paddle_rentals_per_month > 0 ? `${r.free_rentals_used} / ${r.free_paddle_rentals_per_month}` : '—' },
    { key: 'effective_status', label: 'Status', render: (r: any) => <StatusBadge status={r.effective_status} /> },
    { key: '_a', label: '', align: 'right' as const, render: (r: any) => (
      <div className="flex justify-end gap-1">
        {['active', 'suspended'].includes(r.effective_status) && <Button variant="ghost" size="icon" aria-label="Membership card" onClick={() => setCard(r)}><IdCard /></Button>}
        {manage && r.effective_status === 'active' && <Button variant="outline" size="sm" onClick={() => setAction({ row: r, action: 'suspend' })}>Suspend</Button>}
        {manage && r.status === 'suspended' && <Button variant="outline" size="sm" onClick={() => setAction({ row: r, action: 'resume' })}>Resume</Button>}
        {manage && ['active', 'suspended'].includes(r.status) && <Button variant="outline" size="sm" className="text-red-700" onClick={() => setAction({ row: r, action: 'cancel' })}>Cancel</Button>}
      </div>) },
  ];

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Membership Management" description="Track memberships, expirations and benefits. Register, renew, upgrade or downgrade from the POS so payment is recorded.">
        {can('pos.use') && <Link to="/pos"><Button><ShoppingCart />Sell / Renew at POS</Button></Link>}
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(plans.data ?? []).filter((p: any) => p.is_active).map((p: any) => <StatCard key={p.id} label={p.name} value={p.active_members} hint={`${peso(p.monthly_price)} / month · ${Number(p.court_discount_percent)}% off courts`} icon={IdCard} tone="brand" />)}
        <StatCard label={`Expiring in ${days} days`} value={expiring.data?.length ?? '…'} icon={BellRing} tone={expiring.data?.length ? 'red' : 'zinc'} />
      </div>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Memberships</TabsTrigger>
          <TabsTrigger value="renewals">Renewal Notices{expiring.data?.length ? ` (${expiring.data.length})` : ''}</TabsTrigger>
          <TabsTrigger value="plans">Plans &amp; Benefits</TabsTrigger>
        </TabsList>
        <TabsContent value="members">
          <Card>
            <CardHeader title="All Memberships" description="Expired memberships are identified automatically and never receive member discounts." action={
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Status">
                <option value="">All statuses</option>
                {['active', 'suspended', 'expired', 'cancelled', 'replaced'].map((s) => <option key={s} value={s}>{labelize(s)}</option>)}
              </Select>} />
            <DataTable rows={list.data} loading={list.isLoading} error={list.error} columns={columns} empty="No memberships yet" emptyHint="Sell a membership from the POS to see it here." />
          </Card>
        </TabsContent>
        <TabsContent value="renewals">
          <Card>
            <CardHeader title="Memberships Due for Renewal" description={`Active memberships expiring within ${days} days. The notice window is set in System Settings; the bell icon also lists them.`} />
            <DataTable rows={expiring.data} loading={expiring.isLoading} columns={columns.filter((c) => !['discounts_used', 'free', 'price_paid'].includes(c.key))} empty="Nothing is expiring soon" />
          </Card>
        </TabsContent>
        <TabsContent value="plans">
          {plans.isLoading ? <LoadingBlock /> : (
            <div className="grid gap-4 md:grid-cols-3">
              {plans.data.map((p: any) => (
                <Card key={p.id} className="p-5">
                  <div className="flex items-start justify-between"><p className="text-base font-bold text-zinc-900">{p.name}</p>{!p.is_active && <Badge>Inactive</Badge>}</div>
                  <p className="mt-1 text-2xl font-extrabold text-brand-700">{peso(p.monthly_price)}<span className="text-sm font-medium text-zinc-500"> / month</span></p>
                  <ul className="mt-3 space-y-1.5 text-sm text-zinc-700">{p.benefits.map((b: string) => <li key={b} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />{b}</li>)}</ul>
                  <p className="mt-3 border-t border-zinc-100 pt-3 text-xs text-zinc-500">Applied by the system: {Number(p.court_discount_percent)}% court discount · {p.free_paddle_rentals_per_month} free paddle rental(s)/month · book {p.advance_booking_days} days ahead{p.priority_booking ? ' · priority booking' : ''}</p>
                </Card>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-500">Plan prices and benefits are edited under Pricing &amp; Packages.</p>
        </TabsContent>
      </Tabs>

      <FormDialog open={!!action} onOpenChange={(o) => !o && setAction(null)} size="sm" title={action ? `${labelize(action.action)} Membership ${action.row.membership_no}` : ''} submitLabel={action ? labelize(action.action) : 'Save'}
        description={action?.action === 'cancel' ? 'Cancelling does not refund the payment. Process a refund from the transaction if needed.' : action?.action === 'suspend' ? 'A suspended membership receives no discounts until it is resumed.' : undefined}
        fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
        onSubmit={async (v) => { await api.post(`/memberships/${action!.row.id}/status`, { action: action!.action, reason: v.reason }); toast.success('Membership updated'); qc.invalidateQueries({ queryKey: ['memberships'] }); qc.invalidateQueries({ queryKey: ['players'] }); }} />
      <CardDialog player={card ? { full_name: card.player_name, player_no: card.player_no, photo_url: card.photo_url } : null} membership={card} onClose={() => setCard(null)} />
    </div>
  );
}
