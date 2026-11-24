import type { Request } from 'express';
import type { Q } from './db';

/** Appends one row to the permanent audit trail. Call inside the same transaction as the change. */
export async function audit(
  q: Q,
  req: Pick<Request, 'user' | 'ip'> | { user?: { id: string; full_name: string } | null; ip?: string },
  action: string,
  entity?: string,
  entityId?: string | null,
  details: Record<string, unknown> = {},
) {
  await q.query(
    `insert into audit_logs (employee_id, employee_name, action, entity, entity_id, details, ip_address)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [req.user?.id ?? null, req.user?.full_name ?? null, action, entity ?? null, entityId ?? null, JSON.stringify(details), req.ip ?? null],
  );
}

/** Shallow diff used to record what an edit changed (old -> new). */
export function diff(before: Record<string, any>, after: Record<string, any>, ignore = ['updated_at', 'created_at', 'password_hash']) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (ignore.includes(k)) continue;
    const a = before?.[k] instanceof Date ? before[k].toISOString() : before?.[k];
    const b = after[k] instanceof Date ? after[k].toISOString() : after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a, to: b };
  }
  return changes;
}
