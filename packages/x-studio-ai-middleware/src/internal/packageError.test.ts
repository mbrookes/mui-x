/**
 * Tests for the package-authored error brand.
 *
 * `isPackageAuthoredError` is the single predicate every redaction site consults
 * before deciding whether to withhold an error message, so a false positive here
 * turns redaction OFF for host-authored text on every one of those sites at once.
 */
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_AUTHORED_ERROR,
  StudioTimeoutError,
  isPackageAuthoredError,
  markPackageAuthored,
} from './packageError';

describe('isPackageAuthoredError', () => {
  it('recognises a withTimeout rejection', () => {
    const err = new StudioTimeoutError('contextEnricher', 15_000);
    expect(isPackageAuthoredError(err)).toBe(true);
    expect(err.message).toBe('contextEnricher timed out after 15000ms');
    expect(err.timeoutMs).toBe(15_000);
  });

  it('recognises an explicitly branded error', () => {
    expect(isPackageAuthoredError(markPackageAuthored(new Error('our own cap tripped')))).toBe(
      true,
    );
  });

  it('rejects an ordinary host error', () => {
    expect(isPackageAuthoredError(new Error('password authentication failed'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isPackageAuthoredError(undefined)).toBe(false);
    expect(isPackageAuthoredError(null)).toBe(false);
    expect(isPackageAuthoredError('a string rejection')).toBe(false);
    // A plain object carrying the brand is still not an `Error`, and the predicate
    // narrows to `Error` for the `err.message` reads at every call site.
    expect(isPackageAuthoredError({ [PACKAGE_AUTHORED_ERROR]: true })).toBe(false);
  });

  it('does not treat a PROTOTYPE-inherited brand as package-authored', () => {
    // The brand used to be read with a plain property access, which walks the prototype
    // chain. The symbol is reachable via `Symbol.for`, so a host that brands its own
    // Error subclass at the prototype — a plausible "mark all my errors relayable"
    // shortcut — flipped redaction OFF for its own error text at every redaction site.
    // The brand is only ever WRITTEN as an own property, so requiring one costs nothing.
    class HostError extends Error {}
    (HostError.prototype as unknown as Record<symbol, unknown>)[PACKAGE_AUTHORED_ERROR] = true;

    const hostErr = new HostError('password authentication failed for user "studio_ro"');
    expect((hostErr as unknown as Record<symbol, unknown>)[PACKAGE_AUTHORED_ERROR]).toBe(true);
    expect(Object.hasOwn(hostErr, PACKAGE_AUTHORED_ERROR)).toBe(false);
    expect(isPackageAuthoredError(hostErr)).toBe(false);
  });

  it('still recognises a subclass that carries the brand as an OWN property', () => {
    // The legitimate shape — what `StudioTimeoutError`'s class field produces.
    const err = markPackageAuthored(new (class extends Error {})('our own cap tripped'));
    expect(Object.hasOwn(err, PACKAGE_AUTHORED_ERROR)).toBe(true);
    expect(isPackageAuthoredError(err)).toBe(true);
  });
});
