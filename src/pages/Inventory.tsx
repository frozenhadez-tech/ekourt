import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, Scale, Undo2, Wrench } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { CrudSection, FormDialog } from '@/components/forms';
import { Badge, Button, Card, CardHeader, DataTable, PageHeader, Select, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, labelize, peso } from '@/lib/format';

export default function Inventory() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can('inventory.manage');
  const [move, setMove] = React.useState<{ product: any; type: 'stock_in' | 'stock_out' | 'adjustment' } | null>(null);
  const [adjust, setAdjust] = React.useState<any | null>(null);
  const [ret, setRet] = React.useState<any | null>(null);
  const [rentalStatus, setRentalStatus] = React.useState('rented');

  const products = useQuery({ queryKey: ['products', ''], queryFn: () => api.get('/products') });
  const categories = useQuery({ queryKey: ['product-categories', ''], queryFn: () => api.get('/product-categories') });
  const suppliers = useQuery({ queryKey: ['suppliers', ''], queryFn: () => api.get('/suppliers') });
  const movements = useQuery({ queryKey: ['inventory-movements'], queryFn: () => api.get('/inventory/movements') });
  const rentals = useQuery({ queryKey: ['rentals', rentalStatus], queryFn: () => api.get('/rentals', { status: rentalStatus }) });

  const activeProducts = (products.data ?? []).filter((p: any) => p.status === 'active');
  const low = activeProducts.filter((p: any) => p.low_stock);
  // Integer centavos for the on-screen valuation summary.
  const valuation = (key: 'cost_price' | 'selling_price') => activeProducts.reduce((a: number, p: any) => a + Math.round(Number(p[key]) * 100) * p.stock_qty, 0) / 100;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['products'] }); qc.invalidateQueries({ queryKey: ['inventory-movements'] }); qc.invalidateQueries({ queryKey: ['equipment'] }); qc.invalidateQueries({ queryKey: ['rentals'] }); };
  const opts = (rows: any[] | undefined) => (rows ?? []).filter((r) => r.is_active !== false).map((r) => ({ value: r.id, label: r.name }));

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Products & Inventory" description="Products sold at the facility, stock movements, suppliers and rental equipment." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active products" value={activeProducts.length} icon={Boxes} />
        <StatCard label="Low / out of stock" value={low.length} icon={AlertTriangle} tone={low.length ? 'red' : 'green'} hint={low.slice(0, 2).map((p: any) => p.name).join(', ') || 'All stocked'} />
        <StatCard label="Inventory value (cost)" value={peso(valuation('cost_price'))} icon={Scale} tone="blue" />
        <StatCard label="Inventory value (retail)" value={peso(valuation('selling_price'))} icon={Scale} tone="brand" />
      </div>

      <Tabs defaultValue={manage ? 'products' : 'rentals'}>
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="movements">Stock Movements</TabsTrigger>
          <TabsTrigger value="equipment">Rental Equipment</TabsTrigger>
          <TabsTrigger value="rentals">Rentals</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          <CrudSection title="Products" description="Stock is never typed directly: use Stock In, Stock Out or Adjust so every change is recorded. POS sales deduct stock automatically." endpoint="/products" queryKey="products" noun="Product" canManage={manage} deleteLabel="Archive" deletable={(r: any) => r.status === 'active'}
            rowActions={(p: any) => manage && p.status === 'active' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setMove({ product: p, type: 'stock_in' })}><ArrowDownToLine />In</Button>
                <Button variant="outline" size="sm" onClick={() => setMove({ product: p, type: 'stock_out' })}><ArrowUpFromLine />Out</Button>
                <Button variant="outline" size="sm" onClick={() => setMove({ product: p, type: 'adjustment' })}><Wrench />Adjust</Button>
              </>)}
            columns={[
              { key: 'code', label: 'Code', className: 'font-medium text-zinc-900' },
              { key: 'name', label: 'Product', render: (r: any) => <span className="inline-flex items-center gap-2">{r.image_url && <img src={r.image_url} alt="" className="size-8 rounded object-cover" />}{r.name}</span> },
              { key: 'category_name', label: 'Category' }, { key: 'supplier_name', label: 'Supplier' },
              { key: 'cost_price', label: 'Cost', align: 'right', render: (r: any) => peso(r.cost_price) },
              { key: 'selling_price', label: 'Price', align: 'right', render: (r: any) => <b>{peso(r.selling_price)}</b> },
              { key: 'stock_qty', label: 'Stock', align: 'right', render: (r: any) => <span className={r.low_stock ? 'font-bold text-red-600' : 'font-semibold'}>{r.stock_qty}</span> },
              { key: 'min_stock', label: 'Min', align: 'right' },
              { key: 'status', label: 'Status', render: (r: any) => r.status === 'archived' ? <StatusBadge status="archived" /> : r.stock_qty === 0 ? <Badge tone="red">Out of stock</Badge> : r.low_stock ? <Badge tone="amber">Low stock</Badge> : <Badge tone="green">In stock</Badge> },
            ]}
            fields={[
              { name: 'code', label: 'Product code', required: true }, { name: 'name', label: 'Product name', required: true },
              { name: 'category_id', label: 'Category', type: 'select', options: opts(categories.data) }, { name: 'supplier_id', label: 'Supplier', type: 'select', options: opts(suppliers.data) },
              { name: 'cost_price', label: 'Cost price (₱)', type: 'money', required: true }, { name: 'selling_price', label: 'Selling price (₱)', type: 'money', required: true },
              { name: 'min_stock', label: 'Minimum stock (alert level)', type: 'number', default: 0 },
              { name: 'status', label: 'Status', type: 'select', required: true, default: 'active', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] },
              { name: 'image_url', label: 'Product image', type: 'file' }, { name: 'description', label: 'Description', type: 'textarea' },
            ]} emptyHint="New products start at zero stock. Use Stock In to receive inventory." />
        </TabsContent>

        <TabsContent value="movements">
          <Card>
            <CardHeader title="Stock Movements" description="Permanent ledger of every stock-in, stock-out, adjustment, sale and refund (latest 500)." />
            <DataTable rows={movements.data} loading={movements.isLoading} error={movements.error} empty="No stock movements yet" columns={[
              { key: 'created_at', label: 'Date', render: (r: any) => fmtDateTime(r.created_at) },
              { key: 'product_name', label: 'Product', render: (r: any) => <>{r.product_name}<span className="block text-xs text-zinc-500">{r.product_code}</span></> },
              { key: 'movement_type', label: 'Type', render: (r: any) => <Badge tone={{ stock_in: 'green', stock_out: 'orange', adjustment: 'blue', sale: 'zinc', refund: 'violet' }[r.movement_type as string]}>{labelize(r.movement_type)}</Badge> },
              { key: 'quantity', label: 'Change', align: 'right', render: (r: any) => <span className={r.quantity < 0 ? 'font-semibold text-red-600' : 'font-semibold text-emerald-700'}>{r.quantity > 0 ? '+' : ''}{r.quantity}</span> },
              { key: 'balance_after', label: 'Balance', align: 'right' },
              { key: 'notes', label: 'Notes', render: (r: any) => r.transaction_no ?? r.notes ?? '—' },
              { key: 'created_by_name', label: 'By' },
            ]} />
          </Card>
        </TabsContent>

        <TabsContent value="equipment">
          <CrudSection title="Rental Equipment" description="Rental prices and unit counts. Issuing a rental at the POS reserves units so the same item is never issued twice." endpoint="/equipment" queryKey="equipment" noun="Equipment" canManage={manage} deleteLabel="Deactivate" deletable={(r: any) => r.is_active}
            rowActions={(e: any) => manage && <Button variant="outline" size="sm" onClick={() => setAdjust(e)}><Wrench />Units</Button>}
            columns={[
              { key: 'code', label: 'Code', className: 'font-medium text-zinc-900' }, { key: 'name', label: 'Equipment' },
              { key: 'rental_rate', label: 'Rate', align: 'right', render: (r: any) => <><b>{peso(r.rental_rate)}</b> <span className="text-xs text-zinc-500">{labelize(r.charge_method).toLowerCase()}</span></> },
              { key: 'total_qty', label: 'Total', align: 'center' },
              { key: 'available_qty', label: 'Available', align: 'center', render: (r: any) => <b className={r.available_qty === 0 ? 'text-red-600' : 'text-emerald-700'}>{r.available_qty}</b> },
              { key: 'rented_qty', label: 'Rented out', align: 'center' }, { key: 'damaged_qty', label: 'Damaged', align: 'center' }, { key: 'missing_qty', label: 'Missing', align: 'center' },
              { key: 'entitlement_type', label: 'Member free rental', render: (r: any) => (r.entitlement_type ? 'Yes' : '—') },
              { key: 'is_active', label: 'Status', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
            ]}
            fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
              { name: 'rental_rate', label: 'Rental rate (₱)', type: 'money', required: true },
              { name: 'charge_method', label: 'Charged', type: 'select', required: true, default: 'per_session', options: [{ value: 'per_hour', label: 'Per hour' }, { value: 'per_session', label: 'Per session' }, { value: 'per_use', label: 'Per use' }] },
              { name: 'entitlement_type', label: 'Covered by member free rentals', type: 'select', options: [{ value: 'free_paddle_rental', label: 'Yes — counts as free paddle rental' }] },
              { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' }, { name: 'description', label: 'Description', type: 'textarea' },
            ]} emptyHint="After adding equipment, use Units to set how many you own." />
        </TabsContent>

        <TabsContent value="rentals">
          <Card>
            <CardHeader title="Equipment Rentals" description="Issued from the POS. Record each return here, including damaged or missing units." action={
              <Select value={rentalStatus} onChange={(e) => setRentalStatus(e.target.value)} className="w-52" aria-label="Rental status">
                <option value="rented">Currently rented</option><option value="returned">Returned</option><option value="returned_with_issues">Returned with issues</option><option value="">All</option>
              </Select>} />
            <DataTable rows={rentals.data} loading={rentals.isLoading} error={rentals.error} empty="No rentals to show" columns={[
              { key: 'rental_no', label: 'Rental No.', className: 'font-medium text-zinc-900' },
              { key: 'equipment_name', label: 'Equipment', render: (r: any) => `${r.quantity} × ${r.equipment_name}` },
              { key: 'customer_name', label: 'Customer', render: (r: any) => <>{r.customer_name}{r.player_no && <span className="block text-xs text-zinc-500">{r.player_no}</span>}</> },
              { key: 'rented_at', label: 'Rented', render: (r: any) => fmtDateTime(r.rented_at) },
              { key: 'expected_return_at', label: 'Expected return', render: (r: any) => <span className={r.overdue ? 'font-semibold text-red-600' : ''}>{fmtDateTime(r.expected_return_at)}{r.overdue ? ' (overdue)' : ''}</span> },
              { key: 'returned_at', label: 'Actual return', render: (r: any) => fmtDateTime(r.returned_at) },
              { key: 'charge', label: 'Charge', align: 'right', render: (r: any) => (r.is_free_entitlement ? <Badge tone="green">Member free</Badge> : peso(r.charge)) },
              { key: 'issues', label: 'Damaged / Missing', align: 'center', render: (r: any) => (r.status === 'rented' ? '—' : `${r.qty_damaged} / ${r.qty_missing}`) },
              { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              { key: '_a', label: '', align: 'right', render: (r: any) => r.status === 'rented' && can('rentals.manage') && <Button size="sm" onClick={() => setRet(r)}><Undo2 />Return</Button> },
            ]} />
          </Card>
        </TabsContent>

        <TabsContent value="categories">
          <CrudSection title="Product Categories" endpoint="/product-categories" queryKey="product-categories" noun="Category" canManage={manage}
            columns={[{ key: 'name', label: 'Category', className: 'font-medium text-zinc-900' }, { key: 'description', label: 'Description' }, { key: 'is_active', label: 'Status', render: (r: any) => <Badge tone={r.is_active ? 'green' : 'zinc'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' }, { name: 'description', label: 'Description', type: 'textarea' }]} />
        </TabsContent>
        <TabsContent value="suppliers">
          <CrudSection title="Suppliers" endpoint="/suppliers" queryKey="suppliers" noun="Supplier" canManage={manage}
            columns={[{ key: 'name', label: 'Supplier', className: 'font-medium text-zinc-900' }, { key: 'contact_person', label: 'Contact person' }, { key: 'contact_number', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'address', label: 'Address' }]}
            fields={[{ name: 'name', label: 'Supplier name', required: true, full: true }, { name: 'contact_person', label: 'Contact person' }, { name: 'contact_number', label: 'Contact number' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'is_active', label: 'Status', type: 'checkbox', default: true, placeholder: 'Active' }, { name: 'address', label: 'Address', type: 'textarea' }]} />
        </TabsContent>
      </Tabs>

      <FormDialog open={!!move} onOpenChange={(o) => !o && setMove(null)} size="sm" title={move ? `${labelize(move.type)} — ${move.product.name}` : ''} submitLabel="Record"
        description={move ? `Current stock: ${move.product.stock_qty}` : undefined}
        fields={move?.type === 'adjustment'
          ? [{ name: 'quantity', label: 'Actual counted quantity', type: 'number', required: true, full: true, default: move.product.stock_qty }, { name: 'notes', label: 'Reason', type: 'textarea', required: true }]
          : [{ name: 'quantity', label: 'Quantity', type: 'number', required: true, full: true },
             ...(move?.type === 'stock_in' ? [{ name: 'unit_cost', label: 'Unit cost (₱, updates cost price)', type: 'money' as const, full: true, default: move.product.cost_price }] : []),
             { name: 'notes', label: move?.type === 'stock_in' ? 'Notes / delivery reference' : 'Reason', type: 'textarea' as const, required: move?.type !== 'stock_in' }]}
        onSubmit={async (v) => { await api.post('/inventory/movements', { ...v, unit_cost: v.unit_cost === '' ? undefined : v.unit_cost, product_id: move!.product.id, movement_type: move!.type }); toast.success('Stock updated'); refresh(); }} />

      <FormDialog open={!!adjust} onOpenChange={(o) => !o && setAdjust(null)} size="sm" title={`${adjust?.name} — Unit Count`} submitLabel="Save counts" initial={adjust}
        description="Available units are recalculated: total − damaged − missing − currently rented out."
        fields={[{ name: 'total_qty', label: 'Total units owned', type: 'number', required: true, full: true }, { name: 'damaged_qty', label: 'Damaged (out of service)', type: 'number', required: true }, { name: 'missing_qty', label: 'Missing', type: 'number', required: true }, { name: 'notes', label: 'Notes', type: 'textarea' }]}
        onSubmit={async (v) => { await api.post(`/equipment/${adjust.id}/adjust`, v); toast.success('Unit counts updated'); refresh(); }} />

      <FormDialog open={!!ret} onOpenChange={(o) => !o && setRet(null)} size="sm" title={`Return ${ret?.rental_no}`} submitLabel="Record return"
        description={ret ? `${ret.quantity} × ${ret.equipment_name} rented by ${ret.customer_name}. Units not marked damaged or missing go back to available stock.` : undefined}
        fields={[{ name: 'qty_damaged', label: 'Damaged units', type: 'number', default: 0 }, { name: 'qty_missing', label: 'Missing units', type: 'number', default: 0 }, { name: 'notes', label: 'Notes', type: 'textarea' }]}
        onSubmit={async (v) => { await api.post(`/rentals/${ret.id}/return`, v); toast.success('Return recorded'); refresh(); }} />
    </div>
  );
}
