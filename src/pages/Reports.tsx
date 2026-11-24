import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Button, Card, CardHeader, DataTable, Input, PageHeader, Select } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { exportCSV, exportPDF, exportXLSX } from '@/lib/export';
import { cn, fmtDate, fmtDateTime, labelize, num, peso, today } from '@/lib/format';

const PRESETS: [string, () => [string, string]][] = [
  ['Today', () => [today(), today()]],
  ['Last 7 days', () => [dayjs(today()).subtract(6, 'day').format('YYYY-MM-DD'), today()]],
  ['This month', () => [dayjs(today()).startOf('month').format('YYYY-MM-DD'), today()]],
  ['Last month', () => [dayjs(today()).subtract(1, 'month').startOf('month').format('YYYY-MM-DD'), dayjs(today()).subtract(1, 'month').endOf('month').format('YYYY-MM-DD')]],
  ['This year', () => [dayjs(today()).startOf('year').format('YYYY-MM-DD'), today()]],
];

export default function Reports() {
  const [id, setId] = React.useState('daily_sales');
  const [from, setFrom] = React.useState(() => dayjs(today()).startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = React.useState(today);
  const catalog = useQuery({ queryKey: ['reports'], queryFn: () => api.get('/reports'), staleTime: Infinity });
  const report = useQuery({ queryKey: ['report', id, from, to], queryFn: () => api.get(`/reports/${id}`, { from, to }), enabled: from <= to });
  const r = report.data;
  const groups = ['Daily', 'Monthly', 'Business'];

  const fmt = (row: any, c: any) => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return <span className="text-zinc-400">—</span>;
    if (c.type === 'money') return peso(v);
    if (c.type === 'number') return num(v);
    if (c.type === 'date') return fmtDate(v);
    if (c.type === 'datetime') return fmtDateTime(v);
    return typeof v === 'string' && /^[a-z]+(_[a-z]+)*$/.test(v) && v.length < 24 ? labelize(v) : String(v);
  };
  const run = async (kind: 'csv' | 'xlsx' | 'pdf') => {
    if (!r) return;
    const name = `ekourt-${id}-${from}-to-${to}`;
    try {
      if (kind === 'csv') exportCSV(name, r.columns, r.rows);
      else if (kind === 'xlsx') await exportXLSX(name, r.columns, r.rows, r.title);
      else await exportPDF(name, `E-Kourt — ${r.title}`, `${fmtDate(from)} to ${fmtDate(to)} · amounts in PHP · generated ${fmtDateTime(new Date())}`, r.columns, r.rows, r.totals);
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader title="Reports & Analytics" description="Every report is computed from live database records for the selected dates (Asia/Manila).">
        <Button variant="outline" disabled={!r?.rows.length} onClick={() => run('pdf')}><FileText />PDF</Button>
        <Button variant="outline" disabled={!r?.rows.length} onClick={() => run('csv')}><Download />CSV</Button>
        <Button variant="outline" disabled={!r?.rows.length} onClick={() => run('xlsx')}><FileSpreadsheet />Excel</Button>
      </PageHeader>
      <div className="grid items-start gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="hidden p-2 lg:block">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <p className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-400">{g} reports</p>
              {(catalog.data ?? []).filter((x: any) => x.group === g).map((x: any) => (
                <button key={x.id} onClick={() => setId(x.id)} className={cn('block w-full rounded-lg px-3 py-2 text-left text-sm', id === x.id ? 'bg-brand-600 font-semibold text-white' : 'text-zinc-700 hover:bg-zinc-100')}>{x.title}</button>
              ))}
            </div>
          ))}
        </Card>
        <div className="min-w-0 space-y-4">
          <Card className="flex flex-wrap items-center gap-2 p-3">
            <Select value={id} onChange={(e) => setId(e.target.value)} className="lg:hidden" aria-label="Report">
              {groups.map((g) => <optgroup key={g} label={`${g} reports`}>{(catalog.data ?? []).filter((x: any) => x.group === g).map((x: any) => <option key={x.id} value={x.id}>{x.title}</option>)}</optgroup>)}
            </Select>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From date" />
            <span className="text-sm text-zinc-500">to</span>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To date" />
            <div className="flex flex-wrap gap-1">
              {PRESETS.map(([label, get]) => <Button key={label} variant="ghost" size="sm" onClick={() => { const [a, b] = get(); setFrom(a); setTo(b); }}>{label}</Button>)}
            </div>
          </Card>

          {r?.chart && r.rows.length > 0 && (
            <Card>
              <CardHeader title={r.title} description={`${labelize(r.chart.y)} by ${labelize(r.chart.x)}`} />
              <div className="h-64 p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.rows.slice(0, 40).map((row: any) => ({ x: String(row[r.chart.x]).length === 10 && r.chart.x === 'date' ? String(row[r.chart.x]).slice(5) : labelize(String(row[r.chart.x])), y: Number(row[r.chart.y]) }))}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                    <XAxis dataKey="x" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={60} />
                    <Tooltip formatter={(v: any) => (r.columns.find((c: any) => c.key === r.chart.y)?.type === 'money' ? peso(v) : num(v))} cursor={{ fill: '#f4f4f5' }} />
                    <Bar dataKey="y" name={labelize(r.chart.y)} fill="#e2520f" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title={r?.title ?? 'Report'} description={r ? `${r.rows.length} row(s) · ${fmtDate(from)} – ${fmtDate(to)}` : ' '} />
            <DataTable rowKey="__none" rows={r?.rows} loading={report.isLoading} error={report.error} onRetry={() => report.refetch()} empty="No data for this period" emptyHint="Try a wider date range."
              columns={(r?.columns ?? []).map((c: any) => ({ key: c.key, label: c.label, align: c.type === 'money' || c.type === 'number' ? 'right' as const : 'left' as const, render: (row: any) => fmt(row, c) }))}
              footer={r && Object.keys(r.totals).length > 0 && r.rows.length > 0 ? (
                <tfoot><tr className="border-t-2 border-zinc-300 bg-zinc-50 font-bold">
                  {r.columns.map((c: any, i: number) => <td key={c.key} className={cn('px-4 py-2.5', c.type === 'money' || c.type === 'number' ? 'text-right' : '')}>{r.totals[c.key] !== undefined ? peso(r.totals[c.key]) : i === 0 ? 'Total' : ''}</td>)}
                </tr></tfoot>) : undefined} />
          </Card>
        </div>
      </div>
    </div>
  );
}
