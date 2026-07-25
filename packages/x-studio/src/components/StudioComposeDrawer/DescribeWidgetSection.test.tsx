import * as React from 'react';
import { act, createRenderer, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { DescribeWidgetSection } from './DescribeWidgetSection';

const { render } = createRenderer();

/**
 * M11 — `status === 'loading'` was the ONLY re-entrancy guard, and both Cancel and the
 * collapse chevron reset it to `'idle'` while the request was still in flight. Neither
 * aborts the request (the widget is committed by `createWidgetFromDescription` itself), so
 * cancelling never meant "no widget appears" — it only meant the guard was gone, and a
 * resubmit produced a SECOND widget for one intent.
 *
 * The real `createWidgetFromDescription` runs here against a stubbed `fetch` whose
 * resolution this test controls, so the assertions are about widgets actually committed to
 * a real `StudioController` rather than about a mocked helper's call count.
 */
describe('DescribeWidgetSection in-flight re-entrancy (M11)', () => {
  let resolveFetch: ((value: unknown) => void) | undefined;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = vi.fn(() => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resolveFetch = undefined;
  });

  function setup() {
    const harness = createStudioHarness({
      providerProps: { aiConfig: { endpoint: 'https://example.test/ai' } },
    });
    const view = render(<DescribeWidgetSection onCreated={vi.fn()} />, {
      wrapper: harness.wrapper,
    });
    return { ...view, ...harness };
  }

  async function openAndSubmit(user: ReturnType<typeof setup>['user']) {
    await user.click(screen.getByRole('button', { name: 'Describe a widget' }));
    await user.type(screen.getByRole('textbox'), 'revenue by month');
    await user.click(screen.getByRole('button', { name: 'Create' }));
  }

  it('disables Cancel and the collapse control while a request is in flight', async () => {
    const { user } = setup();
    await openAndSubmit(user);

    // The request has not resolved, so the form is still in its loading state.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);
  });

  it('cannot be made to create two widgets for one intent', async () => {
    const { user, controller } = setup();
    await openAndSubmit(user);
    expect(fetchCalls).toBe(1);

    // The escape hatches that used to clear the guard are now blocked, so neither can
    // reset `status` back to `'idle'` and re-open the form for a second submission while
    // the first request is still running.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);
    // The submit button is itself disabled and the guard rejects a re-entrant call, so the
    // second request never happens.
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
    expect(fetchCalls).toBe(1);

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => ({ kind: 'chart', title: 'Revenue', config: {} }),
        text: async () => '',
      });
    });

    // Exactly one widget for one intent.
    expect(Object.keys(controller.getState().doc.widgets).length).toBe(1);
  });

  it('ignores a superseded response instead of stomping the newer state', async () => {
    const { user, controller, unmount } = setup();
    await openAndSubmit(user);

    // The component goes away with the request still in flight — a resolution afterwards
    // must not call `setState` on an unmounted tree.
    unmount();

    await act(async () => {
      resolveFetch?.({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'boom',
      });
    });

    expect(Object.keys(controller.getState().doc.widgets).length).toBe(0);
  });
});
