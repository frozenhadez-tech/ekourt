// Config-driven form dialog and CRUD section used by most management screens.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { api, errMsg } from '@/lib/api';
import { Button, Card, CardHeader, ConfirmDialog, DataTable, Dialog, Field, Input, SearchInput, Select, Textarea, type Column } from './ui';

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'money' | 'date' | 'time' | 'textarea' | 'select' | 'checkbox' | 'multi' | 'file';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  placeholder?: string;
  full?: boolean;
  /** Only shown when creating (e.g. immutable codes are still editable; passwords differ). */
  createOnly?: boolean;
  default?: unknown;
  showIf?: (values: Record<string, any>) => boolean;
}

export function FormFields({ fields, values, onChange }: { fields: FieldDef[]; values: Record<string, any>; onChange: (name: string, value: unknown) => void }) {
  const [uploading, setUploading] = React.useState<string | null>(null);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.filter((f) => !f.showIf || f.showIf(values)).map((f) => {
        const v = values[f.name];
        const common = { id: `f-${f.name}`, required: f.required, placeholder: f.placeholder };
        let input: React.ReactNode;
        if (f.type === 'select') {
          input = (
            <Select {...common} value={v ?? ''} onChange={(e) => onChange(f.name, e.target.value)}>
              {!f.required && <option value="">—</option>}
              {f.required && (v === undefined || v === '' || v === null) && <option value="" disabled>Select…</option>}
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          );
        } else if (f.type === 'textarea') {
          input = <Textarea {...common} value={v ?? ''} onChange={(e) => onChange(f.name, e.target.value)} />;
        } else if (f.type === 'checkbox') {
          input = (
            <label className="flex h-10 items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" className="size-4 accent-brand-600" checked={!!v} onChange={(e) => onChange(f.name, e.target.checked)} /> {f.placeholder ?? 'Yes'}
            </label>
          );
        } else if (f.type === 'multi') {
          const arr: string[] = Array.isArray(v) ? v : [];
          input = (
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-zinc-200 p-3">
              {f.options?.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="checkbox" className="size-4 accent-brand-600" checked={arr.includes(o.value)}
                    onChange={(e) => onChange(f.name, e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} /> {o.label}
                </label>
              ))}
            </div>
          );
        } else if (f.type === 'file') {
          input = (
            <div className="flex items-center gap-3">
              <Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="py-2" disabled={uploading === f.name}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(f.name);
                  try { onChange(f.name, await api.upload(file)); toast.success('File uploaded'); } catch (err) { toast.error(errMsg(err)); } finally { setUploading(null); }
                }} />
              {v && <a href={v} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand-700 underline">View</a>}
            </div>
          );
        } else {
          const isNum = f.type === 'number' || f.type === 'money';
          input = (
            <Input {...common} type={isNum ? 'number' : f.type ?? 'text'} step={f.type === 'money' ? '0.01' : isNum ? 'any' : undefined} min={isNum ? 0 : undefined}
              inputMode={isNum ? 'decimal' : undefined} value={v ?? ''} onChange={(e) => onChange(f.name, e.target.value)}
              autoComplete={f.type === 'password' ? 'new-password' : 'off'} />
          );
        }
        return <Field key={f.name} label={f.label + (f.required ? ' *' : '')} hint={f.hint} className={f.full || f.type === 'textarea' || f.type === 'multi' ? 'sm:col-span-2' : ''}>{input}</Field>;
      })}
    </div>
  );
}

export function FormDialog({ open, onOpenChange, title, description, fields, initial, onSubmit, submitLabel = 'Save', size = 'md', children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; fields: FieldDef[]; initial?: Record<string, any> | null;
  onSubmit: (values: Record<string, any>) => Promise<unknown>; submitLabel?: string; size?: 'sm' | 'md' | 'lg'; children?: React.ReactNode;
}) {
  const [values, setValues] = React.useState<Record<string, any>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const start: Record<string, any> = {};
    for (const f of fields) {
      const raw = initial?.[f.name];
      start[f.name] = raw ?? f.default ?? (f.type === 'checkbox' ? false : f.type === 'multi' ? [] : '');
      if (f.type === 'time' && typeof start[f.name] === 'string') start[f.name] = start[f.name].slice(0, 5);
    }
    setValues(start);
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const visible = fields.filter((f) => !f.showIf || f.showIf(values));
      await onSubmit(Object.fromEntries(visible.map((f) => [f.name, values[f.name]])));
      onOpenChange(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size={size}>
      <form onSubmit={submit} className="space-y-4">
        <FormFields fields={fields} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />
        {children}
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={saving}>{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** List + search + create/edit/delete for one REST resource. */
export function CrudSection<T extends Record<string, any>>({ title, description, endpoint, queryKey, columns, fields, canManage, noun, deleteLabel = 'Delete', deletable = true, rowActions, searchable = true, toolbar, transform, emptyHint }: {
  title: string; description?: string; endpoint: string; queryKey: string; columns: Column<T>[]; fields: FieldDef[]; canManage: boolean; noun: string;
  deleteLabel?: string; deletable?: boolean | ((row: T) => boolean); rowActions?: (row: T) => React.ReactNode; searchable?: boolean; toolbar?: React.ReactNode;
  transform?: (values: Record<string, any>, editing: T | null) => Record<string, any>; emptyHint?: string;
}) {
  const qc = useQueryClient();
  const [q, setQ] = React.useState('');
  const [editing, setEditing] = React.useState<T | null>(null);
  const [open, setOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState<T | null>(null);
  const list = useQuery<T[]>({ queryKey: [queryKey, q], queryFn: () => api.get(endpoint, { q }) });

  const save = async (values: Record<string, any>) => {
    const body = transform ? transform(values, editing) : values;
    if (editing) await api.put(`${endpoint}/${editing.id}`, body);
    else await api.post(endpoint, body);
    toast.success(`${noun} ${editing ? 'updated' : 'added'}`);
    qc.invalidateQueries({ queryKey: [queryKey] });
  };
  const remove = useMutation({
    mutationFn: (row: T) => api.del(`${endpoint}/${row.id}`),
    onSuccess: () => { toast.success(`${noun} ${deleteLabel.toLowerCase()}d`); setRemoving(null); qc.invalidateQueries({ queryKey: [queryKey] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const cols: Column<T>[] = canManage || rowActions
    ? [...columns, {
        key: '_actions', label: '', align: 'right',
        render: (row) => (
          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {rowActions?.(row)}
            {canManage && <Button variant="ghost" size="icon" aria-label={`Edit ${noun}`} onClick={() => { setEditing(row); setOpen(true); }}><Pencil /></Button>}
            {canManage && (typeof deletable === 'function' ? deletable(row) : deletable) && (
              <Button variant="ghost" size="icon" aria-label={`${deleteLabel} ${noun}`} className="text-red-600 hover:bg-red-50" onClick={() => setRemoving(row)}><Trash2 /></Button>
            )}
          </div>
        ),
      }]
    : columns;

  return (
    <Card>
      <CardHeader title={title} description={description} action={
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          {searchable && <SearchInput value={q} onChange={setQ} />}
          {canManage && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus />Add {noun}</Button>}
        </div>} />
      <DataTable columns={cols} rows={list.data} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={`No ${noun.toLowerCase()}s yet`} emptyHint={emptyHint} />
      <FormDialog open={open} onOpenChange={setOpen} title={`${editing ? 'Edit' : 'Add'} ${noun}`} fields={fields.filter((f) => !f.createOnly || !editing)} initial={editing} onSubmit={save} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`${deleteLabel} ${noun}?`} danger confirmLabel={deleteLabel} loading={remove.isPending}
        message={<>This will {deleteLabel.toLowerCase()} <b>{removing?.name ?? removing?.code ?? 'this record'}</b>.</>} onConfirm={() => removing && remove.mutate(removing)} />
    </Card>
  );
}
