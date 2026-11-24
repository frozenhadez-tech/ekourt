import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ROLE_PERMISSIONS, roleCan, type Permission, type Role } from '../shared/permissions';
import { db, one, type Q } from './db';
import { env } from './env';
import { forbidden, HttpError, type AuthUser } from './http';

export const COOKIE = 'ek_session';

export function signSession(emp: { id: string; token_version: number }) {
  return jwt.sign({ sub: emp.id, tv: emp.token_version }, env.jwtSecret, { expiresIn: `${env.sessionHours}h` });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.isProd,
    maxAge: env.sessionHours * 3600 * 1000,
    path: '/',
  });
}

export function toAuthUser(e: any): AuthUser {
  const role = e.role as Role;
  return { id: e.id, employee_no: e.employee_no, full_name: e.full_name, email: e.email, role, permissions: ROLE_PERMISSIONS[role] ?? [] };
}

/** Every request re-reads the employee row, so deactivation and password changes take effect immediately. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED');
  let payload: { sub: string; tv: number };
  try {
    payload = jwt.verify(token, env.jwtSecret) as any;
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again', 'UNAUTHENTICATED');
  }
  const emp = await one(db, 'select * from employees where id = $1', [payload.sub]);
  if (!emp || !emp.is_active || emp.token_version !== payload.tv) {
    throw new HttpError(401, 'Your session is no longer valid. Please sign in again', 'UNAUTHENTICATED');
  }
  req.user = toAuthUser(emp);
  next();
}

/** Route guard: the signed-in employee needs at least one of the listed permissions. */
export const can = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED');
  if (!perms.some((p) => req.user!.permissions.includes(p))) throw forbidden();
  next();
};

export const has = (user: AuthUser, perm: Permission) => user.permissions.includes(perm);

/**
 * Manager override: a second employee authorises a sensitive action (refund, restricted discount)
 * by entering their own credentials at the till.
 */
export async function verifyApprover(q: Q, creds: { email: string; password: string } | undefined | null, perm: Permission) {
  if (!creds?.email || !creds?.password) throw forbidden('Manager approval is required for this action', 'APPROVAL_REQUIRED');
  const emp = await one(q, 'select * from employees where lower(email) = lower($1) and is_active', [creds.email.trim()]);
  const ok = emp && (await bcrypt.compare(creds.password, emp.password_hash));
  if (!ok) throw forbidden('Approver email or password is incorrect', 'APPROVAL_INVALID');
  if (!roleCan(emp.role, perm)) throw forbidden(`${emp.full_name} is not authorised to approve this`, 'APPROVAL_INVALID');
  return toAuthUser(emp);
}

// ---- brute-force throttle for login and approvals -----------------------
const attempts = new Map<string, { count: number; until: number }>();
export function throttle(key: string, max = 8, windowMs = 15 * 60_000) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.count >= max) {
    throw new HttpError(429, 'Too many failed attempts. Please wait a few minutes and try again', 'THROTTLED');
  }
  return {
    fail() {
      const cur = attempts.get(key);
      if (!cur || cur.until <= now) attempts.set(key, { count: 1, until: now + windowMs });
      else cur.count++;
    },
    ok() {
      attempts.delete(key);
    },
  };
}
