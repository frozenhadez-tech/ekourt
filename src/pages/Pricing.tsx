import { useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { CrudSection, FormDialog } from '@/components/forms';
import { Badge, Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtTime, labelize, peso } from '@/lib/format';

const ITEM_TYPES = [
  { value: 'court', label: 'Court rental' }, { value: 'product', label: 'Products' }, { value: 'service', label: 'Services' },
  { value: 'equipment', label: 'Equipment rental' }, { value: 'membership', label: 'Memberships' }, { value: 'charge', label: 'Other charges' },
];
const active = (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Inactive'}</Badge>;

export default function Pricing() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const pricing = can('pricing.manage');
  const [benefitsFor, setBenefitsFor] = React.useState<any | null>(null);
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Pricing & Packages" description="All prices are data, not code. Changes apply to new transactions only; past transactions keep the price that was charged." />
      <Tabs defaultValue={pricing ? 'rates' : 'discounts'}>
        <TabsList>
          {pricing && <TabsTrigger value="rates">Court Rates</TabsTrigger>}
          {pricing && <TabsTrigger value="holidays">Holidays</TabsTrigger>}
          {pricing && <TabsTrigger value="plans">Membership Plans</TabsTrigger>}
          {can('discounts.manage') && <TabsTrigger value="discounts">Discounts &amp; Promos</TabsTrigger>}
        </TabsList>

        <TabsContent value="rates">
          <CrudSection title="Court Rental Price List" endpoint="/court-rates" queryKey="court-rates" noun="Rate" canManage={pricing}
            description="Precedence when booking: Promo → Holiday → Peak → Off-peak → Weekend / Weekday. Durations without an exact package are priced with the cheapest combination."
            columns={[
              { key: 'rate_type', label: 'Rate type', render: (r: any) => <Badge tone={{ weekday: 'zinc', weekend: 'blue', holiday: 'red', peak: 'orange', off_peak: 'green', promo: 'violet' }[r.rate_type as string]}>{labelize(r.rate_type)}</Badge> },
              { key: 'name', label: 'Package', className: 'font-medium text-zinc-900' },
              { key: 'duration_hours', label: 'Hours', align: 'right', render: (r: any) => Number(r.duration_hours) },
              { key: 'price', label: 'Price', align: 'right', render: (r: any) => <b>{peso(r.price)}</b> },
              { key: 'day_scope', label: 'Days', render: (r: any) => labelize(r.day_scope) },
              { key: 'window', label: 'Time window', render: (r: any) => (r.start_time || r.end_time ? `${fmtTime(r.start_time)} – ${fmtTime(r.end_time)}` : 'Any time') },
              { key: 'valid', label: 'Valid dates', render: (r: any) => (r.valid_from || r.valid_to ? `${fmtDate(r.valid_from)} – ${fmtDate(r.valid_to)}` : 'Always') },
              { key: 'is_active', label: 'Status', render: active },
            ]}
            fields={[
              { name: 'rate_type', label: 'Rate type', type: 'select', required: true, default: 'weekday', options: ['weekday', 'weekend', 'holiday', 'peak', 'off_peak', 'promo'].map((v) => ({ value: v, label: labelize(v) })) },
              { name: 'name', label: 'Package name', required: true, placeholder: 'e.g. 2 Hours' },
              { name: 'duration_hours', label: 'Duration (hours)', type: 'number', required: true, hint: 'Half Day = 6, Whole Day = 12 by default.' },
              { name: 'price', label: 'Price (₱)', type: 'money', required: true },
              { name: 'day_scope', label: 'Applies on', type: 'select', required: true, default: 'all', options: [{ value: 'all', label: 'All days' }, { value: 'weekday', label: 'Weekdays only' }, { value: 'weekend', label: 'Weekends only' }], showIf: (v) => ['peak', 'off_peak', 'promo', 'holiday'].includes(v.rate_type) },
              { name: 'start_time', label: 'Window starts', type: 'time', showIf: (v) => ['peak', 'off_peak', 'promo'].includes(v.rate_type), hint: 'Required for peak / off-peak.' },
              { name: 'end_time', label: 'Window ends', type: 'time', showIf: (v) => ['peak', 'off_peak', 'promo'].includes(v.rate_type) },
              { name: 'valid_from', label: 'Valid from', type: 'date', showIf: (v) => v.rate_type === 'promo' },
              { name: 'valid_to', label: 'Valid to', type: 'date', showIf: (v) => v.rate_type === 'promo' },
              { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' },
            ]} />
        </TabsContent>

        <TabsContent value="holidays">
          <CrudSection title="Holidays" description="Bookings on these dates use Holiday rates when any are defined." endpoint="/holidays" queryKey="holidays" noun="Holiday" canManage={pricing} searchable={false}
            columns={[{ key: 'holiday_date', label: 'Date', render: (r: any) => fmtDate(r.holiday_date) }, { key: 'name', label: 'Holiday', className: 'font-medium text-zinc-900' }]}
            fields={[{ name: 'holiday_date', label: 'Date', type: 'date', required: true }, { name: 'name', label: 'Name', required: true }]} />
        </TabsContent>

        <TabsContent value="plans">
          <CrudSection title="Membership Plans" description="Monthly price is multiplied by the duration (quarterly ×3, semi-annual ×6, annual ×12; configurable in Settings)." endpoint="/membership-plans" queryKey="membership-plans" noun="Plan" canManage={pricing} deleteLabel="Deactivate" deletable={(r: any) => r.is_active} searchable={false}
            rowActions={(row: any) => pricing && <Button variant="outline" size="sm" onClick={() => setBenefitsFor(row)}><ListChecks />Benefits</Button>}
            columns={[
              { key: 'code', label: 'Code', className: 'font-medium text-zinc-900' }, { key: 'name', label: 'Plan' },
              { key: 'monthly_price', label: 'Monthly price', align: 'right', render: (r: any) => <b>{peso(r.monthly_price)}</b> },
              { key: 'court_discount_percent', label: 'Court discount', align: 'right', render: (r: any) => `${Number(r.court_discount_percent)}%` },
              { key: 'free_paddle_rentals_per_month', label: 'Free paddle rentals / mo', align: 'center' },
              { key: 'advance_booking_days', label: 'Advance booking (days)', align: 'center' },
              { key: 'priority_booking', label: 'Priority', render: (r: any) => (r.priority_booking ? 'Yes' : 'No') },
              { key: 'active_members', label: 'Members', align: 'center' }, { key: 'is_active', label: 'Status', render: active },
            ]}
            fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Plan name', required: true },
              { name: 'monthly_price', label: 'Monthly price (₱)', type: 'money', required: true },
              { name: 'court_discount_percent', label: 'Court rental discount (%)', type: 'number', required: true, default: 0 },
              { name: 'free_paddle_rentals_per_month', label: 'Free paddle rentals per month', type: 'number', default: 0 },
              { name: 'advance_booking_days', label: 'Advance booking window (days)', type: 'number', default: 14 },
              { name: 'sort_order', label: 'Display order', type: 'number', default: 0 },
              { name: 'priority_booking', label: 'Priority booking', type: 'checkbox', placeholder: 'Members get priority reservations' },
              { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active (can be sold)' },
              { name: 'description', label: 'Description', type: 'textarea' },
            ]} />
          <FormDialog open={!!benefitsFor} onOpenChange={(o) => !o && setBenefitsFor(null)} title={`${benefitsFor?.name} — Benefits`} description="One benefit per line. Shown to cashiers and on plan cards."
            initial={{ benefits: (benefitsFor?.benefits ?? []).join('\n') }} fields={[{ name: 'benefits', label: 'Benefits', type: 'textarea' }]}
            onSubmit={async (v) => { await api.put(`/membership-plans/${benefitsFor.id}/benefits`, { benefits: String(v.benefits).split('\n').map((s) => s.trim()).filter(Boolean) }); toast.success('Benefits saved'); qc.invalidateQueries({ queryKey: ['membership-plans'] }); }} />
        </TabsContent>

        <TabsContent value="discounts">
          <CrudSection title="Discounts & Promotions" endpoint="/discounts" queryKey="discounts" noun="Discount" canManage={can('discounts.manage')} deleteLabel="Deactivate" deletable={(r: any) => r.is_active}
            description="One discount per sale. A discount never stacks on the membership discount unless you allow it; otherwise the customer gets whichever is larger. Senior / PWD amounts follow the statutory rate and VAT rule in System Settings."
            columns={[
              { key: 'name', label: 'Name', className: 'font-medium text-zinc-900' },
              { key: 'code', label: 'Promo code', render: (r: any) => r.code ? <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{r.code}</code> : '—' },
              { key: 'discount_type', label: 'Type', render: (r: any) => labelize(r.discount_type) },
              { key: 'value', label: 'Value', align: 'right', render: (r: any) => ['senior', 'pwd'].includes(r.discount_type) ? 'Statutory' : r.value_type === 'percent' ? `${Number(r.value)}%` : peso(r.value) },
              { key: 'applies_to', label: 'Eligible items', render: (r: any) => ['senior', 'pwd'].includes(r.discount_type) ? 'Per Settings' : r.applies_to.length ? r.applies_to.map(labelize).join(', ') : 'Everything' },
              { key: 'min_amount', label: 'Min. spend', align: 'right', render: (r: any) => (Number(r.min_amount) > 0 ? peso(r.min_amount) : '—') },
              { key: 'valid', label: 'Validity', render: (r: any) => (r.valid_from || r.valid_to ? `${fmtDate(r.valid_from)} – ${fmtDate(r.valid_to)}` : 'Always') },
              { key: 'usage', label: 'Used', align: 'center', render: (r: any) => `${r.usage_count}${r.usage_limit ? ` / ${r.usage_limit}` : ''}` },
              { key: 'requires_approval', label: 'Approval', render: (r: any) => (r.requires_approval ? <Badge tone="amber">Manager</Badge> : '—') },
              { key: 'is_active', label: 'Status', render: active },
            ]}
            fields={[
              { name: 'name', label: 'Name', required: true, full: true },
              { name: 'discount_type', label: 'Discount type', type: 'select', required: true, default: 'promo', options: ['percentage', 'fixed', 'promo', 'senior', 'pwd', 'special_event'].map((v) => ({ value: v, label: v === 'senior' ? 'Senior Citizen' : labelize(v) })) },
              { name: 'code', label: 'Promo code (optional)', placeholder: 'e.g. SUMMER20' },
              { name: 'value_type', label: 'Value is', type: 'select', required: true, default: 'percent', options: [{ value: 'percent', label: 'Percentage (%)' }, { value: 'fixed', label: 'Fixed amount (₱)' }], showIf: (v) => !['senior', 'pwd'].includes(v.discount_type) },
              { name: 'value', label: 'Value', type: 'number', required: true, default: 0, showIf: (v) => !['senior', 'pwd'].includes(v.discount_type) },
              { name: 'min_amount', label: 'Minimum eligible amount (₱)', type: 'money', default: '0' },
              { name: 'usage_limit', label: 'Usage limit (blank = unlimited)', type: 'number' },
              { name: 'valid_from', label: 'Valid from', type: 'date' }, { name: 'valid_to', label: 'Valid to', type: 'date' },
              { name: 'applies_to', label: 'Eligible items (none ticked = everything)', type: 'multi', options: ITEM_TYPES, showIf: (v) => !['senior', 'pwd'].includes(v.discount_type) },
              { name: 'requires_approval', label: 'Authorisation', type: 'checkbox', placeholder: 'Requires manager approval' },
              { name: 'stackable_with_membership', label: 'Stacking', type: 'checkbox', placeholder: 'May combine with membership discount' },
              { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' },
            ]}
            transform={(v) => ({ ...v, value: v.value === undefined || v.value === '' ? 0 : v.value, value_type: v.value_type ?? 'percent', applies_to: v.applies_to ?? [] })} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
