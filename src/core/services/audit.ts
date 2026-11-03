/**
 * Audit trail.
 *
 * Every financial or configuration-changing operation appends an immutable
 * audit row. Audit rows are never updated or deleted by application code.
 */
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  severity?: AuditSeverity;
  details?: Record<string, unknown>;
}

export function recordAudit(ctx: Ctx, input: AuditInput): string {
  const id = newId();
  const at = ctx.clock.nowIso();
  ctx.db.run(
    `INSERT INTO audit_log (id, at, biz_date, user_id, action, entity, entity_id, severity, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      at,
      ctx.clock.todayBizDate(),
      ctx.userId,
      input.action,
      input.entity,
      input.entityId ?? null,
      input.severity ?? 'info',
      input.details ? JSON.stringify(input.details) : null,
    ],
  );
  return id;
}

export interface AuditRow {
  id: string;
  at: string;
  biz_date: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  severity: AuditSeverity;
  details: string | null;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export function queryAuditLog(ctx: Ctx, q: AuditQuery = {}): AuditRow[] {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('biz_date <= ?');
    params.push(q.to);
  }
  if (q.entity) {
    where.push('entity = ?');
    params.push(q.entity);
  }
  if (q.entityId) {
    where.push('entity_id = ?');
    params.push(q.entityId);
  }
  if (q.action) {
    where.push('action = ?');
    params.push(q.action);
  }
  params.push(Math.min(q.limit ?? 200, 1000));
  params.push(q.offset ?? 0);
  return ctx.db.all<AuditRow>(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
    params,
  );
}
