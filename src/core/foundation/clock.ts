/**
 * Time handling.
 *
 * Business dates are recorded twice: an absolute UTC instant (`at`) and a
 * local business date (`biz_date`, YYYY-MM-DD). Day-based financial reports
 * group by `biz_date` so that a sale made at 00:15 local time lands in the
 * correct business day regardless of the machine's UTC offset.
 */

export interface Clock {
  /** Current instant as ISO-8601 UTC string. */
  nowIso(): string;
  /** Current local business date, YYYY-MM-DD. */
  todayBizDate(): string;
  /** Local business date for an arbitrary instant. */
  bizDateOf(iso: string): string;
}

const DEFAULT_TZ_OFFSET_MINUTES = 360; // Asia/Dhaka (UTC+6)

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

export function isoFromParts(date: Date): string {
  return date.toISOString();
}

export function bizDateFrom(date: Date, offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Business date for an ISO instant using a fixed offset (default Asia/Dhaka). */
export function bizDateOfIso(iso: string, offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO instant: ${iso}`);
  }
  return bizDateFrom(parsed, offsetMinutes);
}

export class SystemClock implements Clock {
  constructor(private readonly offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {}

  nowIso(): string {
    return new Date().toISOString();
  }

  todayBizDate(): string {
    return bizDateFrom(new Date(), this.offsetMinutes);
  }

  bizDateOf(iso: string): string {
    return bizDateOfIso(iso, this.offsetMinutes);
  }
}

/** Fixed clock for deterministic tests. */
export class FixedClock implements Clock {
  constructor(
    private current: Date = new Date('2026-01-01T06:00:00.000Z'),
    private readonly offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES,
  ) {}

  nowIso(): string {
    return this.current.toISOString();
  }

  todayBizDate(): string {
    return bizDateFrom(this.current, this.offsetMinutes);
  }

  bizDateOf(iso: string): string {
    return bizDateOfIso(iso, this.offsetMinutes);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

/** Validate a YYYY-MM-DD business date string. */
export function assertBizDate(value: string, label = 'date'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be formatted YYYY-MM-DD (received "${value}")`);
  }
  return value;
}

/** First and last business date of a month ("2026-02" -> 2026-02-01 .. 2026-02-29). */
export function monthRange(year: number, month1: number): { from: string; to: string } {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const last = new Date(Date.UTC(year, month1, 0));
  return {
    from: bizDateFrom(first, 0),
    to: bizDateFrom(last, 0),
  };
}

/** Inclusive list of business dates between two dates. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid date range ${from}..${to}`);
  }
  while (cursor.getTime() <= end.getTime()) {
    out.push(bizDateFrom(cursor, 0));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return out;
}
