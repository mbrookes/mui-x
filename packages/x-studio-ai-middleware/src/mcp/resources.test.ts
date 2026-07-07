/**
 * Unit tests for `mcp/resources.ts`'s `resources/subscribe` handler.
 *
 * The subscribe/unsubscribe coverage in the top-level `mcp.test.ts` only
 * exercises the "handler exists and runs" happy path through the full
 * `buildStudioMcpServer` composition root, with no way to assert on
 * `subscribedUris` membership directly. This file exercises
 * `registerResourceHandlers` directly against a locally constructed
 * `subscribedUris` set so the validation + bound added for finding 4.7 can be
 * asserted precisely.
 */

import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerResourceHandlers } from './resources';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioDataSource } from '../models/studioTypes';
import type { StudioStateBox } from './types';

const SUBSCRIBE = 'resources/subscribe';
const UNSUBSCRIBE = 'resources/unsubscribe';
const PAGE_ID = 'page-1';

/** Access the internal handler map on the low-level Server object. */
function getHandler(
  server: Server,
  method: string,
): (req: { params: Record<string, unknown>; method: string }) => Promise<unknown> {
  // eslint-disable-next-line no-underscore-dangle
  const handlers = (server as any)._requestHandlers as Map<string, (req: any) => Promise<unknown>>;
  const h = handlers?.get(method);
  if (!h) {
    throw new Error(`No handler registered for "${method}"`);
  }
  return h;
}

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'source-orders',
    label: 'Orders',
    tableName: 'orders',
    fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    ...overrides,
  } as StudioDataSource;
}

function makeStateBox(): StudioStateBox {
  return {
    current: createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Test', activePageId: PAGE_ID },
        pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] } },
      },
      runtime: {
        dataSources: { 'source-orders': makeSource() },
      },
    }),
  };
}

/** Build a bare `Server` with `registerResourceHandlers` wired up, plus the
 * locally constructed `subscribedUris` set so membership can be asserted. */
function makeServer(maxSubscribedUris?: number) {
  const server = new Server(
    { name: 'test', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  );
  const subscribedUris = new Set<string>();
  registerResourceHandlers(server, {
    stateBox: makeStateBox(),
    customWidgets: [],
    subscribedUris,
    ...(maxSubscribedUris !== undefined && { maxSubscribedUris }),
  });
  return { server, subscribedUris };
}

describe('resources/subscribe', () => {
  it('accepts a subscribe to studio://dashboard/state', async () => {
    const { server, subscribedUris } = makeServer();
    const result = await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.has('studio://dashboard/state')).toBe(true);
  });

  it('accepts subscribes to studio://schema/{id} and studio://data/{id}', async () => {
    const { server, subscribedUris } = makeServer();
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://schema/source-orders' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://data/source-orders' },
      method: SUBSCRIBE,
    });
    expect(subscribedUris.has('studio://schema/source-orders')).toBe(true);
    expect(subscribedUris.has('studio://data/source-orders')).toBe(true);
  });

  it.each([
    ['https://evil.example/x'],
    ['not-a-uri'],
    ['studio://bogus/thing'],
    ['studio://schema/'],
    ['studio://data/'],
  ])('rejects subscribing to %s and leaves the set unchanged', async (uri) => {
    const { server, subscribedUris } = makeServer();
    await expect(
      getHandler(server, SUBSCRIBE)({ params: { uri }, method: SUBSCRIBE }),
    ).rejects.toThrow(/Cannot subscribe to unknown resource URI/);
    expect(subscribedUris.size).toBe(0);
  });

  it('rejects a new URI once maxSubscribedUris is reached, but still allows re-subscribing an existing member', async () => {
    const { server, subscribedUris } = makeServer(3);
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/system-prompt' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://schema/source-orders' },
      method: SUBSCRIBE,
    });
    expect(subscribedUris.size).toBe(3);

    // A 4th distinct valid URI is rejected — the set is at capacity.
    await expect(
      getHandler(
        server,
        SUBSCRIBE,
      )({
        params: { uri: 'studio://data/source-orders' },
        method: SUBSCRIBE,
      }),
    ).rejects.toThrow(/reached its limit/);
    expect(subscribedUris.size).toBe(3);

    // Re-subscribing an existing member still succeeds even at capacity.
    const result = await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.size).toBe(3);
  });
});

describe('resources/unsubscribe', () => {
  it('unsubscribing a never-subscribed URI is a harmless no-op', async () => {
    const { server, subscribedUris } = makeServer();
    const result = await getHandler(
      server,
      UNSUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: UNSUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.size).toBe(0);
  });
});
