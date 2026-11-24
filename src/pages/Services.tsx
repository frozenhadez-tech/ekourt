import { CrudSection } from '@/components/forms';
import { Badge, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { labelize, peso } from '@/lib/format';

const METHODS = [
  { value: 'per_hour', label: 'Per Hour' }, { value: 'per_person', label: 'Per Person' }, { value: 'per_session', label: 'Per Session' },
  { value: 'per_item', label: 'Per Item' }, { value: 'fixed', label: 'Fixed Price' },
];
const CATEGORIES = ['general', 'facility', 'coaching', 'tournament', 'court'].map((v) => ({ value: v, label: labelize(v) }));

export default function Services() {
  const { can } = useAuth();
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Services & Other Charges" description="Every active service is selectable in the POS. Disable a service to hide it without losing history." />
      <CrudSection title="Services" endpoint="/services" queryKey="services" noun="Service" canManage={can('services.manage')} deleteLabel="Disable" deletable={(r: any) => r.is_active}
        columns={[
          { key: 'code', label: 'Code', className: 'font-medium text-zinc-900' },
          { key: 'name', label: 'Service' },
          { key: 'description', label: 'Description' },
          { key: 'category', label: 'Category', render: (r: any) => labelize(r.category) },
          { key: 'charge_method', label: 'Charging method', render: (r: any) => labelize(r.charge_method) },
          { key: 'price', label: 'Price', align: 'right', render: (r: any) => <b>{peso(r.price)}</b> },
          { key: 'is_active', label: 'Status', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Enabled' : 'Disabled'}</Badge> },
        ]}
        fields={[
          { name: 'code', label: 'Code', required: true },
          { name: 'name', label: 'Service name', required: true },
          { name: 'category', label: 'Category', type: 'select', required: true, default: 'general', options: CATEGORIES, hint: 'Coaching and Tournament set the transaction type in reports.' },
          { name: 'charge_method', label: 'Charging method', type: 'select', required: true, default: 'fixed', options: METHODS },
          { name: 'price', label: 'Price (₱)', type: 'money', required: true },
          { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Enabled (shown in POS)' },
          { name: 'description', label: 'Description', type: 'textarea' },
        ]} />
    </div>
  );
}
