/**
 * Kernel context.
 *
 * `Ctx` is the explicit dependency bundle passed to every service function:
 * database, clock and the identity of the operator performing the action.
 * Explicit dependencies keep services pure, testable and free of hidden
 * globals (important for an offline desktop app that must be auditable).
 */
import type { Clock } from './foundation/clock';
import { SystemClock } from './foundation/clock';
import type { Db } from './db/context';

export interface Ctx {
  db: Db;
  clock: Clock;
  /** Operator user id, or null for system/scheduled actions. */
  userId: string | null;
}

export function createCtx(db: Db, opts: { clock?: Clock; userId?: string | null } = {}): Ctx {
  return {
    db,
    clock: opts.clock ?? new SystemClock(),
    userId: opts.userId ?? null,
  };
}

/** Return a new context bound to a different operator. */
export function withUser(ctx: Ctx, userId: string | null): Ctx {
  return { ...ctx, userId };
}
