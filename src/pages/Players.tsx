import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IdCard, Pencil, Plus, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import * as React from 'react';
import { toast } from 'sonner';
import { FormDialog, type FieldDef } from '@/components/forms';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, LoadingBlock, PageHeader, SearchInput, Select, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSettings } from '@/lib/auth';
import { printElement } from '@/lib/export';
import { fmtDate, fmtDateTime, fmtTime, labelize, peso } from '@/lib/format';

const FIELDS: FieldDef[] = [
  { name: 'full_name', label: 'Full name', required: true, full: true },
  { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] },
  { name: 'birthday', label: 'Birthday', type: 'date' },
  { name: 'contact_number', label: 'Contact number', hint: 'Must be unique per player.' },
  { name: 'email', label: 'Email address', type: 'email', hint: 'Must be unique per player.' },
  { name: 'address', label: 'Complete address', type: 'textarea' },
  { name: 'emergency_contact_name', label: 'Emergency contact name' },
  { name: 'emergency_contact_number', label: 'Emergency contact number' },
  { name: 'status', label: 'Player status', type: 'select', required: true, default: 'active', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'banned', label: 'Banned' }] },
  { name: 'photo_url', label: 'Player photo (optional)', type: 'file' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/** CR80-sized ID card with a QR code of the player number. Also used for membership cards. */
export function PlayerCard({ player, businessName, membership }: { player: any; businessName: string; membership?: { plan_name: string; membership_no: string; end_date: string } | null }) {
  return (
    <div className="card" style={{ width: '85.6mm', height: '54mm', border: '1px solid #222', borderRadius: '3mm', overflow: 'hidden', fontFamily: 'Arial, sans-serif', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' }}>
      <div style={{ background: '#17171a', color: '#fff', padding: '2.2mm 4mm', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 800, fontSize: '4.2mm', letterSpacing: '0.2mm' }}>{businessName}</span>
        <span style={{ background: '#e2520f', padding: '0.6mm 2mm', borderRadius: '1mm', fontSize: '2.6mm', fontWeight: 700 }}>{membership ? membership.plan_name.toUpperCase() : 'PLAYER ID'}</span>
      </div>
      <div style={{ display: 'flex', gap: '3mm', padding: '3mm 4mm', flex: 1, alignItems: 'center' }}>
        {player.photo_url
          ? <img src={player.photo_url} alt="" style={{ width: '20mm', height: '25mm', objectFit: 'cover', borderRadius: '1.5mm', border: '1px solid #ccc' }} />
          : <div style={{ width: '20mm', height: '25mm', borderRadius: '1.5mm', background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9mm', fontWeight: 800, color: '#999' }}>{player.full_name?.slice(0, 1)}</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '4mm', fontWeight: 800, lineHeight: 1.15 }}>{player.full_name}</div>
          <div style={{ fontSize: '3.4mm', fontWeight: 700, color: '#e2520f', marginTop: '1mm' }}>{player.player_no}</div>
          {membership
            ? <div style={{ fontSize: '2.6mm', marginTop: '1.5mm', color: '#333' }}>{membership.membership_no}<br />Valid until {fmtDate(membership.end_date)}</div>
            : <div style={{ fontSize: '2.6mm', marginTop: '1.5mm', color: '#333' }}>Registered {fmtDate(player.registration_date)}<br />{player.contact_number ?? ''}</div>}
        </div>
        <QRCodeSVG value={membership ? `${player.player_no}|${membership.membership_no}` : player.player_no} size={78} level="M" />
      </div>
    </div>
  );
}

export function CardDialog({ player, membership, onClose }: { player: any | null; membership?: any; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const settings = useSettings();
  return (
    <Dialog open={!!player} onOpenChange={(o) => !o && onClose()} title={membership ? 'Membership Card' : 'Player ID Card'} size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={() => printElement(ref.current, 90)}><Printer />Print card</Button></>}>
      {player && <div className="flex justify-center overflow-x-auto py-2"><div ref={ref}><PlayerCard player={player} businessName={settings.data?.business_name ?? 'E-Kourt'} membership={membership} /></div></div>}
      <p className="mt-2 text-center text-xs text-zinc-500">Scan the QR code to look the player up by ID at the front desk.</p>
    </Dialog>
  );
}

export default function Players() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [q, setQ] = React.useState('');
  const [membership, setMembership] = React.useState('');
  const [form, setForm] = React.useState<{ open: boolean; row: any | null }>({ open: false, row: null });
  const [profile, setProfile] = React.useState<string | null>(null);
  const [card, setCard] = React.useState<any | null>(null);
  const list = useQuery({ queryKey: ['players', 'list', q, membership], queryFn: () => api.get('/players', { q, membership, limit: 300 }) });
  const manage = can('players.manage');

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Player Management" description="Registered players, profiles and ID cards. Walk-in customers can still transact without registering.">
        {manage && <Button onClick={() => setForm({ open: true, row: null })}><Plus />Register Player</Button>}
      </PageHeader>
      <Card>
        <CardHeader title="Players" description={`${list.data?.length ?? 0} shown`} action={
          <div className="flex flex-wrap gap-2">
            <Select value={membership} onChange={(e) => setMembership(e.target.value)} className="w-48" aria-label="Membership status">
              <option value="">All membership statuses</option>
              {['active', 'expired', 'suspended', 'none'].map((s) => <option key={s} value={s}>{s === 'none' ? 'Non-member' : labelize(s)}</option>)}
            </Select>
            <SearchInput value={q} onChange={setQ} placeholder="Name, ID, phone or email…" />
          </div>} />
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => setProfile(r.id)} empty="No players found" emptyHint="Register your first player to start tracking bookings and memberships."
          columns={[
            { key: 'player_no', label: 'Player ID', className: 'font-medium text-zinc-900' },
            { key: 'full_name', label: 'Full name' },
            { key: 'contact_number', label: 'Contact' },
            { key: 'email', label: 'Email' },
            { key: 'registration_date', label: 'Registered', render: (r: any) => fmtDate(r.registration_date) },
            { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'membership_status', label: 'Membership', render: (r: any) => r.membership_status === 'none' ? <Badge>Non-member</Badge> : <span className="inline-flex items-center gap-1.5"><StatusBadge status={r.membership_status} /><span className="text-xs text-zinc-500">{r.plan_name}</span></span> },
            { key: '_a', label: '', align: 'right', render: (r: any) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon" aria-label="ID card" onClick={() => setCard(r)}><IdCard /></Button>
                {manage && <Button variant="ghost" size="icon" aria-label="Edit player" onClick={() => setForm({ open: true, row: r })}><Pencil /></Button>}
              </div>) },
          ]} />
      </Card>

      <FormDialog open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} title={form.row ? `Edit ${form.row.player_no}` : 'Register New Player'} size="lg"
        description={form.row ? undefined : 'A Player ID (EK-000001 format) is generated automatically.'} fields={FIELDS} initial={form.row}
        onSubmit={async (v) => {
          const p = form.row ? await api.put(`/players/${form.row.id}`, v) : await api.post('/players', v);
          toast.success(form.row ? 'Player updated' : `Registered ${p.player_no}`);
          qc.invalidateQueries({ queryKey: ['players'] });
          qc.invalidateQueries({ queryKey: ['player'] });
        }} />
      <ProfileDialog id={profile} onClose={() => setProfile(null)} onCard={setCard} />
      <CardDialog player={card} onClose={() => setCard(null)} />
    </div>
  );
}

function ProfileDialog({ id, onClose, onCard }: { id: string | null; onClose: () => void; onCard: (p: any) => void }) {
  const p = useQuery({ queryKey: ['player', id], queryFn: () => api.get(`/players/${id}`), enabled: !!id });
  const d = p.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()} title={d ? d.full_name : 'Player'} description={d?.player_no} size="xl"
      footer={d && <><Button variant="outline" onClick={() => onCard(d)}><IdCard />ID card</Button><Button variant="outline" onClick={onClose}>Close</Button></>}>
      {!d ? <LoadingBlock /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            {d.photo_url ? <img src={d.photo_url} alt="" className="size-24 rounded-xl border border-zinc-200 object-cover" /> : <div className="flex size-24 items-center justify-center rounded-xl bg-zinc-100 text-3xl font-bold text-zinc-400">{d.full_name.slice(0, 1)}</div>}
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              {[
                ['Status', <StatusBadge status={d.status} />], ['Membership', d.membership_status === 'none' ? 'Non-member' : <span className="inline-flex gap-1.5"><StatusBadge status={d.membership_status} />{d.plan_name}</span>],
                ['Membership ends', fmtDate(d.membership_end)], ['Registered', fmtDate(d.registration_date)],
                ['Gender', labelize(d.gender)], ['Birthday', fmtDate(d.birthday)], ['Contact', d.contact_number ?? '—'], ['Email', d.email ?? '—'],
                ['Address', d.address ?? '—'], ['Emergency contact', d.emergency_contact_name ? `${d.emergency_contact_name} · ${d.emergency_contact_number ?? ''}` : '—'],
              ].map(([l, v], i) => <div key={i} className={i >= 8 ? 'col-span-2' : ''}><dt className="text-xs text-zinc-500">{l}</dt><dd className="font-medium text-zinc-900">{v}</dd></div>)}
            </dl>
          </div>
          <Tabs defaultValue="bookings">
            <TabsList>
              <TabsTrigger value="bookings">Bookings ({d.reservations.length})</TabsTrigger>
              <TabsTrigger value="payments">Payments ({d.payments.length})</TabsTrigger>
              <TabsTrigger value="rentals">Rentals ({d.rentals.length})</TabsTrigger>
              <TabsTrigger value="memberships">Memberships ({d.memberships.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="bookings">
              <DataTable rows={d.reservations} empty="No booking history" columns={[
                { key: 'reference_no', label: 'Reference', className: 'font-medium' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) },
                { key: 't', label: 'Time', render: (r: any) => `${fmtTime(r.start_time)} – ${fmtTime(r.end_time)}` }, { key: 'court_name', label: 'Court' },
                { key: 'total_amount', label: 'Total', align: 'right', render: (r: any) => peso(r.total_amount) }, { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
            </TabsContent>
            <TabsContent value="payments">
              <DataTable rows={d.payments} empty="No payment history" columns={[
                { key: 'created_at', label: 'Date', render: (r: any) => fmtDateTime(r.created_at) }, { key: 'transaction_no', label: 'Transaction', className: 'font-medium' },
                { key: 'kind', label: 'Kind', render: (r: any) => labelize(r.kind) }, { key: 'method', label: 'Method', render: (r: any) => labelize(r.method) },
                { key: 'amount', label: 'Amount', align: 'right', render: (r: any) => peso(r.amount) },
              ]} />
            </TabsContent>
            <TabsContent value="rentals">
              <DataTable rows={d.rentals} empty="No rental history" columns={[
                { key: 'rental_no', label: 'Rental', className: 'font-medium' }, { key: 'equipment_name', label: 'Equipment' }, { key: 'quantity', label: 'Qty', align: 'right' },
                { key: 'rented_at', label: 'Rented', render: (r: any) => fmtDateTime(r.rented_at) }, { key: 'returned_at', label: 'Returned', render: (r: any) => fmtDateTime(r.returned_at) },
                { key: 'charge', label: 'Charge', align: 'right', render: (r: any) => r.is_free_entitlement ? 'Free (member)' : peso(r.charge) }, { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
            </TabsContent>
            <TabsContent value="memberships">
              <DataTable rows={d.memberships} empty="No membership history" columns={[
                { key: 'membership_no', label: 'Membership', className: 'font-medium' }, { key: 'plan_name', label: 'Plan' }, { key: 'action', label: 'Type', render: (r: any) => labelize(r.action) },
                { key: 'duration', label: 'Duration', render: (r: any) => labelize(r.duration) }, { key: 'start_date', label: 'Start', render: (r: any) => fmtDate(r.start_date) },
                { key: 'end_date', label: 'End', render: (r: any) => fmtDate(r.end_date) }, { key: 'price_paid', label: 'Paid', align: 'right', render: (r: any) => peso(r.price_paid) },
                { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </Dialog>
  );
}
