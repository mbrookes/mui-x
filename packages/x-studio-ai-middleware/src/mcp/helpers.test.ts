/**
 * Unit tests for the error-redaction boundary in `mcp/helpers.ts`.
 *
 * The redaction (finding H4) exists so host- and DB-authored error text — which
 * routinely carries credentials, SQL fragments, and internal hostnames — never
 * reaches the model or, through the chat transport's SSE stream, the browser.
 *
 * It must NOT extend to error text this package authored. A `withTimeout` rejection
 * names a server-authored label and a constant duration and nothing else; withholding
 * it costs the operator the one signal that distinguishes "the call hung" from "the
 * database rejected the query", for no security gain. Both halves are pinned here.
 */

import { describe, expect, it, vi } from 'vitest';
import { redactedHostErrorMessage, redactedHostErrorResult, withTimeout } from './helpers';
import { isPackageAuthoredError, StudioTimeoutError } from '../internal/packageError';

describe('withTimeout', () => {
  it('rejects with a branded, package-authored error naming the label and the duration', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => {}), 15_000, 'query_data_source');
      const caught = pending.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(15_000);
      const err = await caught;

      expect(err).toBeInstanceOf(StudioTimeoutError);
      expect((err as StudioTimeoutError).timeoutMs).toBe(15_000);
      expect((err as Error).message).toBe('query_data_source timed out after 15000ms');
      expect(isPackageAuthoredError(err)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not brand an ordinary host rejection that loses the race', async () => {
    const hostError = new Error('password authentication failed for user "studio_ro"');
    await expect(withTimeout(Promise.reject(hostError), 15_000, 'query_data_source')).rejects.toBe(
      hostError,
    );
    expect(isPackageAuthoredError(hostError)).toBe(false);
  });
});

describe('redactedHostErrorMessage', () => {
  it('relays a package-authored timeout verbatim, duration included', async () => {
    vi.useFakeTimers();
    let timeoutErr: unknown;
    try {
      const caught = withTimeout(new Promise<never>(() => {}), 15_000, 'query_data_source').catch(
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      timeoutErr = await caught;
    } finally {
      vi.useRealTimers();
    }

    const logger = { log: vi.fn(), error: vi.fn() };
    const message = redactedHostErrorMessage('query_data_source', timeoutErr, logger);

    expect(message).toMatch(/timed out after 15000ms/);
    // Relayed, not swapped for a correlation id — the duration IS the diagnosis.
    expect(message).not.toMatch(/reference "mcp-/);
    expect(message).not.toMatch(/withheld/);
    // Still logged server-side, like every other failure on this path.
    expect(logger.error).toHaveBeenCalledOnce();
    expect(String(logger.error.mock.calls[0][0])).toMatch(/timed out after 15000ms/);
  });

  it('still redacts a host/DB error to a correlation id and logs the detail', () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const hostError = new Error('password authentication failed for user "studio_ro"');

    const message = redactedHostErrorMessage('query_data_source', hostError, logger);

    // The credential-bearing text never reaches the caller…
    expect(message).not.toContain('studio_ro');
    expect(message).not.toContain('password authentication failed');
    // …only a correlation id the operator resolves in the log.
    const reference = message.match(/reference "(mcp-[^"]+)"/)?.[1];
    expect(reference).toBeDefined();

    expect(logger.error).toHaveBeenCalledOnce();
    const logged = String(logger.error.mock.calls[0][0]);
    expect(logged).toContain('password authentication failed for user "studio_ro"');
    expect(logged).toContain(reference!);
  });

  it('mints a distinct correlation id per redacted failure', () => {
    const first = redactedHostErrorMessage('query_data_source', new Error('a'));
    const second = redactedHostErrorMessage('query_data_source', new Error('b'));
    expect(first.match(/reference "([^"]+)"/)?.[1]).not.toBe(
      second.match(/reference "([^"]+)"/)?.[1],
    );
  });

  it('wraps both outcomes in the standard isError envelope via redactedHostErrorResult', () => {
    const result = redactedHostErrorResult('query_data_source', new Error('db unreachable'));
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as { error: string };
    expect(payload.error).not.toContain('db unreachable');
    expect(payload.error).toMatch(/reference "mcp-/);
  });
});
