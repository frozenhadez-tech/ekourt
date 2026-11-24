import type { NextFunction, Request, Response } from 'express';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { Permission, Role } from '../shared/permissions';

export interface AuthUser {
  id: string;
  employee_no: string;
  full_name: string;
  email: string;
  role: Role;
  permissions: Permission[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`, 'NOT_FOUND');
export const conflict = (m: string, code?: string) => new HttpError(409, m, code);
export const forbidden = (m = 'You do not have permission to do this', code = 'FORBIDDEN') => new HttpError(403, m, code);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
    throw new HttpError(400, msg, 'VALIDATION');
  }
  return r.data;
}

// ---- shared zod pieces -------------------------------------------------
export const zId = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
export const zText = z.string().trim().min(1).max(500);
export const zOptText = z.preprocess(blankToNull, z.string().trim().max(2000).nullable());
export const zOptId = z.preprocess(blankToNull, zId.nullable());
export const zOptDate = z.preprocess(blankToNull, zDate.nullable());
export const zOptTime = z.preprocess(blankToNull, zTime.nullable());
/** Money arrives as a string or number and is normalised to an exact 2-decimal string. */
export const zMoney = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    const d = new Decimal(typeof v === 'string' ? v.trim() : v);
    if (!d.isFinite() || d.isNegative() || d.gt('9999999999')) throw new Error();
    return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid amount' });
    return z.NEVER;
  }
});
export const zInt = z.coerce.number().int();
export const zBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

// ---- error handling ----------------------------------------------------
const PG_ERRORS: Record<string, [number, string]> = {
  '23505': [409, 'A record with the same unique value already exists'],
  '23503': [409, 'This record is referenced by other records and cannot be removed'],
  '23P01': [409, 'That court is already booked for the selected time'],
  '23514': [400, 'A value is outside the allowed range'],
  '22P02': [400, 'Invalid value'],
  '40001': [409, 'The record changed while saving. Please try again'],
  '40P01': [409, 'The record changed while saving. Please try again'],
};

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err?.code === 'P0001') return res.status(400).json({ error: err.message, code: 'RULE' });
  if (err?.code && PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code];
    return res.status(status).json({ error: message, code: err.code, constraint: err.constraint });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: err.message });
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}

export function pageParams(query: Request['query'], maxLimit = 200) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), maxLimit);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
