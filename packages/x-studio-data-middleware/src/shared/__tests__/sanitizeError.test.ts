/**
 * Unit tests for `sanitizeBoundaryError` — the read/write handlers' disclosure
 * boundary.
 *
 * The classification is deliberately a PREFIX test, not a substring test. This
 * package's own errors all begin with `MUI X` and are authored to be safe to
 * disclose; a driver error is not, because a message like
 * `no such column: orders.secret` is a schema oracle that works even on a
 * deployment with no `columnAllowlist` configured.
 *
 * `startsWith` → `includes` is the mutation that survived the audit, and it is a
 * REAL disclosure widening rather than a cosmetic one: a driver message only has
 * to MENTION this package somewhere — `SQLITE_ERROR: no such column:
 * orders.secret (see MUI X docs)`, or an error whose cause chain was concatenated
 * with one of ours — to be forwarded to the caller verbatim. Nothing else in the
 * pipeline re-checks it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeBoundaryError } from '../sanitizeError';

const GENERIC = 'MUI X Studio Server: The query for this widget could not be completed.';

describe('sanitizeBoundaryError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes one of this package's own errors through unchanged", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const own = 'MUI X Studio Server: Requested table(s) not in schema allowlist: payroll';
    expect(sanitizeBoundaryError(new Error(own), GENERIC)).toBe(own);
    // Nothing to log — it was never masked.
    expect(warn).not.toHaveBeenCalled();
  });

  it('masks a driver error and logs the real cause server-side', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const driver = 'SQLITE_ERROR: no such column: orders.secret';
    expect(sanitizeBoundaryError(new Error(driver), GENERIC)).toBe(GENERIC);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(driver);
  });

  it('MASKS a driver error that merely MENTIONS the marker somewhere in its text', () => {
    // THE PREFIX TEST IS THE GUARD. Under `raw.includes(PREFIX)` every one of
    // these is disclosed verbatim, leaking the schema names the generic message
    // exists to withhold.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaky = [
      'SQLITE_ERROR: no such column: orders.secret (see MUI X docs)',
      'error: relation "payroll" does not exist [thrown while handling MUI X Studio Server request]',
      'ER_BAD_FIELD_ERROR: Unknown column "employees.salary" — MUI X',
    ];
    for (const raw of leaky) {
      expect(sanitizeBoundaryError(new Error(raw), GENERIC)).toBe(GENERIC);
      expect(sanitizeBoundaryError(new Error(raw), GENERIC)).not.toContain('secret');
    }
    expect(warn).toHaveBeenCalled();
  });

  it('handles a non-Error throw without disclosing it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sanitizeBoundaryError('orders.secret does not exist', GENERIC)).toBe(GENERIC);
    expect(sanitizeBoundaryError({ code: '42703' }, GENERIC)).toBe(GENERIC);
    // …and a bare string that IS one of ours still passes through.
    expect(sanitizeBoundaryError('MUI X Studio Server: bad descriptor', GENERIC)).toBe(
      'MUI X Studio Server: bad descriptor',
    );
  });
});
