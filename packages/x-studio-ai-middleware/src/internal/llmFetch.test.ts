/**
 * Unit tests for the abort/cleanup helpers every LLM fetch in this package routes
 * through (finding M5).
 *
 * This module is the difference between a timed-out request that STOPS and one that
 * keeps running upstream — fully billed — with an unread body pinning a socket.
 * `withTimeout` alone only makes the CALLER stop waiting. Every behaviour below was
 * previously asserted nowhere: the module had no test file at all, and its consumers
 * (`agenticLoop.ts`, `handleGenerateInsight.ts`, `generateFieldDescriptions.ts`) only
 * ever observe the caller-side half that `withTimeout` already provides.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { linkAbortSignal, readBodyWithTimeout } from './llmFetch';

describe('linkAbortSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an already-aborted signal when the external signal is already aborted', () => {
    // The request was abandoned before the fetch was even issued — issuing it with a
    // live signal would send (and pay for) a completion nobody is waiting for.
    const external = new AbortController();
    external.abort();

    const linked = linkAbortSignal(external.signal, 60_000);

    expect(linked.signal.aborted).toBe(true);
  });

  it('aborts once the deadline elapses', () => {
    vi.useFakeTimers();
    const linked = linkAbortSignal(undefined, 5_000);

    expect(linked.signal.aborted).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(linked.signal.aborted).toBe(true);
  });

  it('aborts as soon as the external signal aborts, before the deadline', () => {
    const external = new AbortController();
    const linked = linkAbortSignal(external.signal, 60_000);

    external.abort();

    expect(linked.signal.aborted).toBe(true);
  });

  it('clearTimer cancels the deadline but keeps the external link alive', () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const linked = linkAbortSignal(external.signal, 5_000);

    // Headers have arrived: the fetch-level deadline no longer applies...
    linked.clearTimer();
    vi.advanceTimersByTime(60_000);
    expect(linked.signal.aborted).toBe(false);

    // ...but an external abort must still tear the streaming response down.
    external.abort();
    expect(linked.signal.aborted).toBe(true);
  });

  it('dispose unsubscribes from the external signal', () => {
    // A host `AbortSignal` can outlive the request — an MCP session signal is reused
    // across every call on it — so a listener left behind is one leak per request, and
    // aborting the session would fire every stale listener at once.
    const external = new AbortController();
    const linked = linkAbortSignal(external.signal, 60_000);

    linked.dispose();
    external.abort();

    expect(linked.signal.aborted).toBe(false);
  });

  it('dispose also cancels the deadline', () => {
    vi.useFakeTimers();
    const linked = linkAbortSignal(undefined, 5_000);

    linked.dispose();
    vi.advanceTimersByTime(60_000);

    expect(linked.signal.aborted).toBe(false);
  });
});

describe('readBodyWithTimeout', () => {
  it('cancels the response body when the read does not settle in time', async () => {
    // A gateway that returns headers and then stalls the body: without the cancel the
    // connection stays open with an unread body for as long as the socket survives.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });

    await expect(
      readBodyWithTimeout(response, () => new Promise<string>(() => {}), 10, 'stalled body'),
    ).rejects.toThrow(/stalled body/);

    expect(cancelled).toBe(true);
  });

  it('returns the read result and leaves the body alone when it settles in time', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });

    await expect(readBodyWithTimeout(response, async () => 'ok', 1_000, 'body')).resolves.toBe(
      'ok',
    );
    expect(cancelled).toBe(false);
  });

  it('still rethrows — and cancels — when the read itself rejects', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });

    await expect(
      readBodyWithTimeout(response, () => Promise.reject(new Error('socket reset')), 1_000, 'body'),
    ).rejects.toThrow('socket reset');
    expect(cancelled).toBe(true);
  });
});
