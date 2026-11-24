// Generic, permission-checked, audited CRUD for simple configuration tables.
import { Router } from 'express';
import { z } from 'zod';
import type { Permission } from '../shared/permissions';
import { audit, diff } from './audit';
import { can } from './auth';
import { db, one, tx, type Q } from './db';
import { notFound, parse, str, zId } from './http';

interface CrudOptions {
  table: string;
  entity: string;
  schema: z.ZodObject<any>;
  view: Permission[];
  manage: Permission[];
  orderBy?: string;
  search?: string[];
  /** SQL select list / joins for the list query, defaults to `t.*` */
  select?: string;
  joins?: string;
  /** How DELETE behaves: flag the row inactive instead of removing it. */
  softDelete?: { column: string; value: unknown };
  noDelete?: boolean;
  afterCreate?: (q: Q, row: any) => Promise<void>;
}

export function crud(o: CrudOptions) {
  const r = Router();
  const cols = Object.keys(o.schema.shape);

  r.get('/', can(...o.view), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    const q = str(req.query.q);
    if (q && o.search?.length) {
      params.push(`%${q.toLowerCase()}%`);
      where.push('(' + o.search.map((c) => `lower(t.${c}::text) like $1`).join(' or ') + ')');
    }
    const sql = `select ${o.select ?? 't.*'} from ${o.table} t ${o.joins ?? ''} ${where.length ? 'where ' + where.join(' and ') : ''} order by ${o.orderBy ?? 't.created_at'}`;
    res.json((await db.query(sql, params)).rows);
  });

  r.post('/', can(...o.manage), async (req, res) => {
    const data = parse(o.schema, req.body) as Record<string, unknown>;
    const keys = cols.filter((c) => data[c] !== undefined);
    const row = await tx(async (q) => {
      const created = await one(
        q,
        `insert into ${o.table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
        keys.map((k) => data[k]),
      );
      await o.afterCreate?.(q, created);
      await audit(q, req, `${o.entity}.create`, o.entity, created.id, { record: created });
      return created;
    });
    res.status(201).json(row);
  });

  r.put('/:id', can(...o.manage), async (req, res) => {
    const id = parse(zId, req.params.id);
    const data = parse(o.schema.partial(), req.body) as Record<string, unknown>;
    const keys = cols.filter((c) => data[c] !== undefined);
    const row = await tx(async (q) => {
      const before = await one(q, `select * from ${o.table} where id = $1 for update`, [id]);
      if (!before) throw notFound();
      if (!keys.length) return before;
      const after = await one(
        q,
        `update ${o.table} set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`,
        [id, ...keys.map((k) => data[k])],
      );
      const changes = diff(before, after);
      if (Object.keys(changes).length) await audit(q, req, `${o.entity}.update`, o.entity, id, { changes });
      return after;
    });
    res.json(row);
  });

  if (!o.noDelete) {
    r.delete('/:id', can(...o.manage), async (req, res) => {
      const id = parse(zId, req.params.id);
      await tx(async (q) => {
        const before = await one(q, `select * from ${o.table} where id = $1`, [id]);
        if (!before) throw notFound();
        if (o.softDelete) {
          await q.query(`update ${o.table} set ${o.softDelete.column} = $2 where id = $1`, [id, o.softDelete.value]);
          await audit(q, req, `${o.entity}.archive`, o.entity, id, { name: before.name ?? before.code });
        } else {
          await q.query(`delete from ${o.table} where id = $1`, [id]);
          await audit(q, req, `${o.entity}.delete`, o.entity, id, { record: before });
        }
      });
      res.json({ ok: true });
    });
  }
  return r;
}
