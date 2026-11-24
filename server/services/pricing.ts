// Court rental pricing. Every price comes from the court_rates table (admin-editable);
// the only fallback is the court's own hourly_rate when no price list row applies.
import { one, type Q } from '../db';
import { badRequest, notFound } from '../http';
import { D, m, r2, ZERO, type Dec } from '../money';
import { activeMembership, getSettings } from './common';

export interface CourtQuoteInput {
  court_id: string;
  date: string; // YYYY-MM-DD (Asia/Manila)
  start_time: string; // HH:MM
  duration_hours: number;
  player_id?: string | null;
}

export interface CourtQuote {
  court: any;
  rate_type: string;
  rate_amount: string;
  discount_percent: string;
  discount_amount: string;
  total: string;
  membership: any | null;
  end_time: string;
}

/** Cheapest way to cover `hours` using the packages of one rate type (half-hour resolution). */
function packagePrice(rates: any[], hours: number): Dec | null {
  const units = Math.round(hours * 2);
  const packs = rates.map((r) => ({ u: Math.round(Number(r.duration_hours) * 2), p: D(r.price) })).filter((p) => p.u > 0);
  if (!packs.length) return null;
  const best: (Dec | null)[] = [ZERO];
  for (let u = 1; u <= units; u++) {
    let min: Dec | null = null;
    for (const p of packs) {
      const prev = p.u <= u ? best[u - p.u] : null;
      if (prev) {
        const c = prev.plus(p.p);
        if (!min || c.lt(min)) min = c;
      }
    }
    best[u] = min;
  }
  if (best[units]) return best[units];
  // No exact combination (e.g. 1.5 h with whole-hour packages): pro-rate the shortest package.
  const shortest = packs.reduce((a, b) => (a.u <= b.u ? a : b));
  return r2(shortest.p.div(shortest.u).times(units));
}

const inWindow = (r: any, start: string) => (!r.start_time || r.start_time.slice(0, 5) <= start) && (!r.end_time || start < r.end_time.slice(0, 5));

export async function quoteCourt(q: Q, input: CourtQuoteInput): Promise<CourtQuote> {
  const court = await one(q, 'select * from courts where id = $1', [input.court_id]);
  if (!court) throw notFound('Court');
  if (!(input.duration_hours > 0) || Math.round(input.duration_hours * 2) !== input.duration_hours * 2) {
    throw badRequest('Duration must be in half-hour steps');
  }

  const info = await one(
    q,
    `select extract(dow from $1::date)::int as dow,
            exists(select 1 from holidays where holiday_date = $1::date) as is_holiday,
            to_char($1::date + $2::time + ($3 || ' minutes')::interval, 'HH24:MI') as end_time`,
    [input.date, input.start_time, Math.round(input.duration_hours * 60)],
  );
  const dayType = info.dow === 0 || info.dow === 6 ? 'weekend' : 'weekday';

  const { rows: rates } = await q.query(
    `select * from court_rates
     where is_active and (valid_from is null or valid_from <= $1::date) and (valid_to is null or valid_to >= $1::date)
       and (day_scope = 'all' or day_scope = $2)`,
    [input.date, dayType],
  );
  const of = (type: string, windowed = false) => rates.filter((r) => r.rate_type === type && (!windowed || inWindow(r, input.start_time)));

  // Precedence: promo > holiday > peak > off-peak > weekend/weekday.
  const candidates: [string, any[]][] = [
    ['promo', of('promo', true)],
    ...(info.is_holiday ? ([['holiday', of('holiday')]] as [string, any[]][]) : []),
    ['peak', of('peak', true).filter((r) => r.start_time || r.end_time)],
    ['off_peak', of('off_peak', true).filter((r) => r.start_time || r.end_time)],
    [dayType, of(dayType)],
  ];

  let rateType = 'court_hourly';
  let amount: Dec | null = null;
  for (const [type, list] of candidates) {
    const price = packagePrice(list, input.duration_hours);
    if (price) {
      rateType = type;
      amount = price;
      break;
    }
  }
  if (!amount) amount = r2(D(court.hourly_rate).times(input.duration_hours));

  const settings = await getSettings(q);
  const membership = (await activeMembership(q, input.player_id)) ?? null;
  const percent = membership && settings.member_discount_types.includes('court') ? D(membership.court_discount_percent) : ZERO;
  const discount = r2(amount.times(percent).div(100));

  return {
    court,
    rate_type: rateType,
    rate_amount: m(amount),
    discount_percent: percent.toFixed(2),
    discount_amount: m(discount),
    total: m(amount.minus(discount)),
    membership,
    end_time: info.end_time,
  };
}
