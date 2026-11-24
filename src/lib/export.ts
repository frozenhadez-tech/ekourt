// CSV / Excel / PDF export and printing. Heavy libraries are loaded only when used.
import { fmtDate, fmtDateTime, labelize } from './format';

export interface ExportColumn { key: string; label: string; type?: 'money' | 'number' | 'date' | 'datetime' | 'text' }

function cell(row: Record<string, any>, col: ExportColumn, forText: boolean): string | number {
  const v = row[col.key];
  if (v === null || v === undefined) return '';
  if (col.type === 'money' || col.type === 'number') return forText ? (col.type === 'money' ? Number(v).toFixed(2) : String(v)) : Number(v);
  if (col.type === 'date') return fmtDate(v);
  if (col.type === 'datetime') return fmtDateTime(v);
  return typeof v === 'string' && /^[a-z]+(_[a-z]+)+$/.test(v) ? labelize(v) : String(v);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCSV(filename: string, columns: ExportColumn[], rows: Record<string, any>[]) {
  // Leading apostrophe neutralises spreadsheet formula injection from user-entered text.
  const esc = (v: string | number) => {
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(cell(r, c, true))).join(','))];
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
}

export async function exportXLSX(filename: string, columns: ExportColumn[], rows: Record<string, any>[], sheet = 'Report') {
  const XLSX = await import('xlsx');
  const data = [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => cell(r, c, false)))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = columns.map((c) => ({ wch: Math.max(c.label.length + 2, c.type === 'money' ? 14 : 16) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

export async function exportPDF(filename: string, title: string, subtitle: string, columns: ExportColumn[], rows: Record<string, any>[], totals?: Record<string, string>) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  doc.setFontSize(14);
  doc.text(title, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(subtitle, 40, 56);
  // jsPDF's built-in fonts have no peso glyph, so amounts are printed as plain numbers under a "PHP" note.
  const money = (v: string | number) => Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = (r: Record<string, any>, c: ExportColumn) => (c.type === 'money' ? money(r[c.key] ?? 0) : String(cell(r, c, true)));
  autoTable(doc, {
    startY: 70,
    head: [columns.map((c) => c.label)],
    body: rows.map((r) => columns.map((c) => fmt(r, c))),
    foot: totals && Object.keys(totals).length ? [columns.map((c, i) => (totals[c.key] !== undefined ? money(totals[c.key]) : i === 0 ? 'TOTAL' : ''))] : undefined,
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [23, 23, 26] },
    footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.type === 'money' || c.type === 'number' ? 'right' : 'left' }])),
  });
  doc.save(`${filename}.pdf`);
}

const PRINT_CSS = `
  @page { margin: 6mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.45; color: #000; }
  .center { text-align: center; } .right { text-align: right; } .bold { font-weight: 700; } .big { font-size: 15px; font-weight: 700; } .muted { color: #444; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 1px 0; vertical-align: top; text-align: left; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .card { font-family: Arial, sans-serif; }
`;

/** Prints one element's markup in an isolated frame so app chrome never reaches the paper. */
export function printElement(el: HTMLElement | null, widthMm = 80) {
  if (!el) return;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>E-Kourt</title><style>${PRINT_CSS} body { width: ${widthMm}mm; }</style></head><body>${el.innerHTML}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1500);
  }, 150);
}
