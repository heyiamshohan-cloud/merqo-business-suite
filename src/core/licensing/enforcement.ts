/**
 * Licence enforcement policy.
 *
 * MERQO is sold offline, so the application cannot phone home. The policy is
 * therefore explicit and bounded:
 *
 *   1. A valid, signed licence (lifetime / trial / subscription) → full access.
 *   2. No licence yet → a 14-day evaluation period, recorded on first run.
 *   3. Evaluation over → read-only: the operator can still open the app, read
 *      everything, export and back up, but cannot post new transactions.
 *
 * Step 3 is deliberately non-destructive: an expired business must never be
 * locked away from its own accounting data. Only document posting is blocked.
 *
 * Honest limitation: because activation state lives in the local database, a
 * determined user with file-system access can extend the evaluation window by
 * restoring an older copy. Offline licensing cannot prevent that; the signed
 * licence is what protects revenue in practice.
 */
import type { Ctx } from '../kernel';
import { getSetting, setSetting } from '../services/settings';
import { AppError } from '../foundation/errors';
import type { LicenseStatus } from './license';

export const EVALUATION_DAYS = 14;
export const EVAL_STARTED_KEY = 'license.eval_started_at';

export interface EvaluationState {
  mode: 'licensed' | 'evaluation' | 'expired';
  /** Days remaining in the evaluation period (0 when licensed or expired). */
  daysLeft: number;
  startedAt: string | null;
  expiresAt: string | null;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/** Start the evaluation clock on first run; idempotent. */
export function startEvaluationIfNeeded(ctx: Ctx, status: LicenseStatus): void {
  if (status.valid) return;
  if (getSetting(ctx.db, EVAL_STARTED_KEY)) return;
  setSetting(ctx.db, EVAL_STARTED_KEY, ctx.clock.nowIso(), ctx.clock.nowIso());
}

export function evaluationState(ctx: Ctx, status: LicenseStatus): EvaluationState {
  if (status.valid) {
    return { mode: 'licensed', daysLeft: 0, startedAt: null, expiresAt: status.expiresAt };
  }
  const startedAt = getSetting(ctx.db, EVAL_STARTED_KEY) ?? null;
  if (!startedAt) {
    return { mode: 'evaluation', daysLeft: EVALUATION_DAYS, startedAt: null, expiresAt: null };
  }
  const expiresAt = addDays(startedAt, EVALUATION_DAYS);
  const remainingMs = new Date(expiresAt).getTime() - new Date(ctx.clock.nowIso()).getTime();
  const daysLeft = Math.ceil(remainingMs / 86_400_000);
  return {
    mode: remainingMs > 0 ? 'evaluation' : 'expired',
    daysLeft: Math.max(0, daysLeft),
    startedAt,
    expiresAt,
  };
}

/**
 * Guard for write operations. Read paths are never guarded — the owner must
 * always be able to reach their own books, export them and take a backup.
 */
export function assertOperatingAllowed(ctx: Ctx, status: LicenseStatus): EvaluationState {
  const state = evaluationState(ctx, status);
  if (state.mode === 'expired') {
    throw new AppError('The evaluation period has ended. Activate MERQO to continue posting transactions.', {
      code: 'LICENSE_EXPIRED',
      messageBn:
        'পরীক্ষামূলক সময় শেষ হয়েছে। নতুন লেনদেন যোগ করতে MERQO সক্রিয় করুন। পড়া, এক্সপোর্ট ও ব্যাকআপ এখনও চালু আছে।',
      details: { evaluationEndedAt: state.expiresAt },
    });
  }
  return state;
}
