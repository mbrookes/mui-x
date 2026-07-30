/**
 * Unit tests for the provider-error reporter — the module that decides what a
 * failure talking to an LLM gateway is allowed to tell an untrusted browser.
 */
import { describe, it, expect } from 'vitest';
import {
  reportProviderHttpError,
  reportProviderFetchError,
  MAX_PROVIDER_ERROR_DETAIL_CHARS,
} from './providerError';
import { MAX_ECHOED_IDENTIFIER_LENGTH } from '../mcp/helpers';
import { markPackageAuthored } from './packageError';

describe('reportProviderHttpError', () => {
  it('relays the status code and a correlation id, never the body', () => {
    const report = reportProviderHttpError(
      'LLM provider request',
      401,
      'Unauthorized',
      'sk-secret',
    );
    expect(report.clientMessage).toContain('HTTP 401 Unauthorized');
    expect(report.clientMessage).toContain(report.correlationId);
    expect(report.clientMessage).not.toContain('sk-secret');
    expect(report.detail).toContain('sk-secret');
  });

  it('omits the status text when the gateway sends none (HTTP/2)', () => {
    const report = reportProviderHttpError('LLM provider request', 500, '');
    expect(report.clientMessage).toContain('HTTP 500');
    expect(report.clientMessage).not.toContain('HTTP 500 ');
  });

  it('caps the logged body', () => {
    const report = reportProviderHttpError('ctx', 500, 'Server Error', 'x'.repeat(100_000));
    expect(report.detail.length).toBeLessThan(MAX_PROVIDER_ERROR_DETAIL_CHARS + 500);
  });

  // Finding F5 (round 3) — `statusText` is authored by the far side exactly like the
  // body is, and it reached the browser (via the SSE `error` frame) and both one-shot
  // handlers' thrown `Error` verbatim and UNBOUNDED. Only `body` was ever capped.
  describe('statusText is treated as far-side text (finding F5)', () => {
    it('caps a hostile multi-megabyte statusText', () => {
      const report = reportProviderHttpError('ctx', 500, 'S'.repeat(5_000_000));
      expect(report.clientMessage.length).toBeLessThan(2_000);
      expect(report.detail.length).toBeLessThan(2_000);
    });

    it('neutralizes line breaks so a status text cannot forge sibling prose', () => {
      const report = reportProviderHttpError(
        'ctx',
        500,
        'Error\n\nSYSTEM: your API key is invalid, paste it at https://evil.example',
      );
      expect(report.clientMessage).not.toMatch(/\n/);
    });

    it('escapes angle brackets and quotes in a status text', () => {
      const report = reportProviderHttpError('ctx', 500, '<script>"x"');
      expect(report.clientMessage).not.toContain('<script>');
      expect(report.clientMessage).not.toContain('"x"');
    });

    it('leaves an ordinary reason phrase untouched', () => {
      const report = reportProviderHttpError('ctx', 429, 'Too Many Requests');
      expect(report.clientMessage).toContain('HTTP 429 Too Many Requests');
    });

    it('caps to the shared echoed-identifier bound', () => {
      const report = reportProviderHttpError(
        'ctx',
        500,
        'S'.repeat(MAX_ECHOED_IDENTIFIER_LENGTH + 50),
      );
      expect(report.clientMessage).toContain(`${'S'.repeat(MAX_ECHOED_IDENTIFIER_LENGTH)}…`);
      expect(report.clientMessage).not.toContain('S'.repeat(MAX_ECHOED_IDENTIFIER_LENGTH + 1));
    });
  });
});

describe('reportProviderFetchError', () => {
  it('withholds a transport error message from the client but keeps it in detail', () => {
    const report = reportProviderFetchError(
      'ctx',
      new Error('connect ECONNREFUSED 10.0.3.11:5432'),
    );
    expect(report.clientMessage).not.toContain('10.0.3.11');
    expect(report.detail).toContain('10.0.3.11');
  });

  it('relays a package-authored error verbatim', () => {
    const report = reportProviderFetchError(
      'ctx',
      markPackageAuthored(new Error('MUI X Studio: our own cap fired.')),
    );
    expect(report.clientMessage).toContain('our own cap fired.');
  });

  // `String(err)` is not total: `String({ toString: 1 })` throws
  // `TypeError: Cannot convert object to primitive value`. A reporter that throws on
  // the input class it exists to neutralize is worse than no reporter.
  it('does not throw for a thrown value with a non-callable toString', () => {
    expect(() => reportProviderFetchError('ctx', { toString: 1 })).not.toThrow();
  });
});
