import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

dayjs.extend(utc);
dayjs.extend(timezone);

export const TZ = 'Asia/Manila';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const pesoFmt = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Formats a decimal string from the API. Display only: all arithmetic happens on the server. */
export const peso = (v: string | number | null | undefined) => `₱${pesoFmt.format(Number(v ?? 0))}`;
export const num = (v: string | number | null | undefined) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2 }).format(Number(v ?? 0));

export const manila = (v?: string | Date | null) => dayjs(v ?? undefined).tz(TZ);
export const today = () => manila().format('YYYY-MM-DD');
export const fmtDate = (v?: string | Date | null) => (v ? (typeof v === 'string' && v.length === 10 ? dayjs(v) : manila(v)).format('MMM D, YYYY') : '—');
export const fmtDateTime = (v?: string | Date | null) => (v ? manila(v).format('MMM D, YYYY h:mm A') : '—');
export const fmtTime = (hhmm?: string | null) => (hhmm ? dayjs(`2000-01-01T${hhmm.slice(0, 5)}`).format('h:mm A') : '—');
export const addDays = (date: string, n: number) => dayjs(date).add(n, 'day').format('YYYY-MM-DD');

export const labelize = (s?: string | null) =>
  s ? s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace('Gcash', 'GCash').replace('Pwd', 'PWD') : '—';

/** Integer-centavo helpers for the few places the UI must add amounts typed by the cashier (tender / change preview). */
export const toCents = (v: string | number | null | undefined) => Math.round(Number(v || 0) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);

export const STATUS_TONE: Record<string, string> = {
  // reservations
  pending: 'amber', confirmed: 'blue', checked_in: 'violet', in_progress: 'orange', completed: 'green', cancelled: 'zinc', no_show: 'red',
  // courts
  available: 'green', reserved: 'blue', occupied: 'orange', maintenance: 'amber', closed: 'zinc',
  // money
  partial: 'amber', refunded: 'red', partially_refunded: 'amber', approved: 'green', rejected: 'red',
  // misc
  active: 'green', inactive: 'zinc', banned: 'red', suspended: 'amber', expired: 'red', replaced: 'zinc', none: 'zinc', archived: 'zinc',
  open: 'green', rented: 'orange', returned: 'green', returned_with_issues: 'red',
};
