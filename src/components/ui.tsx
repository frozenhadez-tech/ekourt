// Shadcn-style primitives (Radix + Tailwind + cva), kept in one module for easy reuse.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { Inbox, Loader2, X } from 'lucide-react';
import * as React from 'react';
import { cn, labelize, STATUS_TONE } from '@/lib/format';

// ---- Button ---------------------------------------------------------------
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        dark: 'bg-ink-900 text-white hover:bg-ink-700',
        outline: 'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50',
        ghost: 'text-zinc-700 hover:bg-zinc-100',
        danger: 'bg-red-600 text-white hover:bg-red-700',
        success: 'bg-emerald-600 text-white hover:bg-emerald-700',
        link: 'text-brand-700 underline-offset-4 hover:underline',
      },
      size: { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4', lg: 'h-12 px-6 text-base', icon: 'size-9' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}
export function Button({ className, variant, size, loading, children, disabled, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </button>
  );
}

// ---- Form controls ---------------------------------------------------------
const control = 'w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 disabled:bg-zinc-100 disabled:text-zinc-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, 'h-10', className)} {...props} />;
}
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, 'min-h-20 py-2', className)} {...props} />;
}
export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, 'h-10 pr-8', className)} {...props}>{children}</select>;
}
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-600', className)} {...props} />;
}
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

// ---- Surfaces ---------------------------------------------------------------
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-zinc-200 bg-white shadow-card', className)} {...props} />;
}
export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/25',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  zinc: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20',
};
export function Badge({ tone = 'zinc', className, children }: { tone?: string; className?: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone] ?? TONES.zinc, className)}>{children}</span>;
}
export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-zinc-400">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? 'zinc'}>{labelize(status)}</Badge>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-zinc-400', className)} />;
}
export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 py-14 text-sm text-zinc-500"><Spinner />{label}</div>;
}
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="rounded-full bg-zinc-100 p-3 text-zinc-400"><Inbox className="size-6" /></div>
      <p className="text-sm font-medium text-zinc-700">{title}</p>
      {hint && <p className="max-w-sm text-xs text-zinc-500">{hint}</p>}
      {action}
    </div>
  );
}
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {error instanceof Error ? error.message : 'Something went wrong'}
      {onRetry && <button onClick={onRetry} className="ml-3 font-semibold underline">Try again</button>}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'zinc' }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; tone?: 'brand' | 'green' | 'red' | 'blue' | 'amber' | 'zinc' }) {
  const tones = { brand: 'bg-brand-50 text-brand-700', green: 'bg-emerald-50 text-emerald-700', red: 'bg-red-50 text-red-700', blue: 'bg-sky-50 text-sky-700', amber: 'bg-amber-50 text-amber-700', zinc: 'bg-zinc-100 text-zinc-600' };
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
          <p className="mt-1.5 truncate text-2xl font-bold tracking-tight text-zinc-900">{value}</p>
          {hint && <p className="mt-1 truncate text-xs text-zinc-500">{hint}</p>}
        </div>
        {Icon && <div className={cn('rounded-lg p-2', tones[tone])}><Icon className="size-5" /></div>}
      </div>
    </Card>
  );
}

// ---- Dialog -----------------------------------------------------------------
export function Dialog({ open, onOpenChange, title, description, children, size = 'md', footer }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl'; footer?: React.ReactNode;
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="animate-fade fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn('animate-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-2xl', widths[size])}
        >
          <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-zinc-900">{title}</DialogPrimitive.Title>
              {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" aria-label="Close"><X className="size-5" /></DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3 rounded-b-2xl">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---- Tabs -------------------------------------------------------------------
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('mb-4 flex gap-1 overflow-x-auto border-b border-zinc-200', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn('-mb-px whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium text-zinc-500 hover:text-zinc-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-700', className)}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

// ---- Data table -------------------------------------------------------------
export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  render?: (row: T) => React.ReactNode;
}

export function DataTable<T extends Record<string, any>>({ columns, rows, loading, error, onRetry, empty = 'No records found', emptyHint, onRowClick, rowKey = 'id', footer }: {
  columns: Column<T>[]; rows?: T[]; loading?: boolean; error?: unknown; onRetry?: () => void; empty?: string; emptyHint?: string;
  onRowClick?: (row: T) => void; rowKey?: string; footer?: React.ReactNode;
}) {
  if (error) return <ErrorBlock error={error} onRetry={onRetry} />;
  if (loading && !rows) return <LoadingBlock />;
  if (!rows?.length) return <EmptyState title={empty} hint={emptyHint} />;
  const align = { left: 'text-left', right: 'text-right', center: 'text-center' };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50/80 text-xs uppercase tracking-wide text-zinc-500">
            {columns.map((c) => <th key={c.key} className={cn('px-4 py-2.5 font-semibold', align[c.align ?? 'left'])}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row, i) => (
            <tr key={row[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(row) : undefined} className={cn('hover:bg-zinc-50/70', onRowClick && 'cursor-pointer')}>
              {columns.map((c) => (
                <td key={c.key} className={cn('px-4 py-2.5 text-zinc-700', align[c.align ?? 'left'], c.className)}>
                  {c.render ? c.render(row) : (row[c.key] ?? <span className="text-zinc-400">—</span>)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer}
      </table>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cn('w-full sm:w-64', className)} />;
}

export function ConfirmDialog({ open, onOpenChange, title, message, confirmLabel = 'Confirm', danger, onConfirm, loading }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; loading?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm"
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="text-sm text-zinc-600">{message}</div>
    </Dialog>
  );
}
