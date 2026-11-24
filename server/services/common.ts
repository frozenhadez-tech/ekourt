import { one, type Q } from '../db';

const pad = (n: number, len = 6) => String(n).padStart(len, '0');

async function next(q: Q, name: string, year: number) {
  return Number((await one(q, 'select next_number($1, $2) as n', [name, year])).n);
}
async function manilaYear(q: Q) {
  return Number((await one(q, `select extract(year from now() at time zone 'Asia/Manila')::int as y`)).y);
}

/** Document numbers. Each call takes a row lock on the counter, so numbers never repeat. */
export const numbers = {
  player: async (q: Q) => `EK-${pad(await next(q, 'player', 0))}`,
  employee: async (q: Q) => `EMP-${pad(await next(q, 'employee', 0) + 1, 4)}`,
  reservation: async (q: Q) => { const y = await manilaYear(q); return `EKB-${y}-${pad(await next(q, 'reservation', y))}`; },
  transaction: async (q: Q) => { const y = await manilaYear(q); return `EKT-${y}-${pad(await next(q, 'transaction', y))}`; },
  refund: async (q: Q) => { const y = await manilaYear(q); return `EKR-${y}-${pad(await next(q, 'refund', y))}`; },
  membership: async (q: Q) => { const y = await manilaYear(q); return `EKM-${y}-${pad(await next(q, 'membership', y))}`; },
  rental: async (q: Q) => { const y = await manilaYear(q); return `EKQ-${y}-${pad(await next(q, 'rental', y))}`; },
  expense: async (q: Q) => { const y = await manilaYear(q); return `EKX-${y}-${pad(await next(q, 'expense', y))}`; },
  shift: async (q: Q) => { const y = await manilaYear(q); return `EKS-${y}-${pad(await next(q, 'shift', y))}`; },
};

export interface Settings {
  business_name: string;
  business_address: string;
  business_contact: string;
  business_tin: string;
  receipt_footer: string;
  vat_registered: boolean;
  vat_rate: number;
  sc_pwd_discount_rate: number;
  sc_pwd_eligible_types: string[];
  member_discount_types: string[];
  require_open_shift: boolean;
  membership_expiry_notice_days: number;
  booking_slot_minutes: number;
  max_advance_booking_days: number;
  duration_months: Record<string, number>;
}

const DEFAULTS: Settings = {
  business_name: 'E-Kourt', business_address: '', business_contact: '', business_tin: '', receipt_footer: '',
  vat_registered: false, vat_rate: 12, sc_pwd_discount_rate: 20, sc_pwd_eligible_types: ['court', 'service', 'equipment'],
  member_discount_types: ['court'], require_open_shift: true, membership_expiry_notice_days: 7, booking_slot_minutes: 60,
  max_advance_booking_days: 30, duration_months: { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 },
};

export async function getSettings(q: Q): Promise<Settings> {
  const { rows } = await q.query('select key, value from business_settings');
  const out: any = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** The player's membership that is valid today (active status and inside its date range), if any. */
export async function activeMembership(q: Q, playerId: string | null | undefined) {
  if (!playerId) return undefined;
  return one(
    q,
    `select pm.*, mp.name as plan_name, mp.code as plan_code, mp.court_discount_percent, mp.free_paddle_rentals_per_month,
            mp.priority_booking, mp.advance_booking_days
     from player_memberships pm join membership_plans mp on mp.id = pm.plan_id
     where pm.player_id = $1 and pm.status = 'active' and manila_today() between pm.start_date and pm.end_date
     limit 1`,
    [playerId],
  );
}

export async function openShift(q: Q, cashierId: string) {
  return one(q, `select * from cashier_shifts where cashier_id = $1 and status = 'open'`, [cashierId]);
}
