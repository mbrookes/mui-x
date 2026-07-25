import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '../../models';
import type { StudioDataSource, StudioDataSourceAdapter, StudioState } from '../../models';
import type { StudioHandle } from './Studio';
import { StudioDashboard } from './StudioDashboard';

const { render } = createRenderer();

/**
 * Regression coverage for Tier-1 finding #9 (architecture review): `StudioDashboard`'s
 * `config` prop reload was a silent no-op — it called
 * `innerRef.current?.loadSerializedState(JSON.stringify(config))`, passing a STRING.
 * `migrateState`'s `validateStateStructure` rejects anything where `typeof state !==
 * 'object'`, so the call always failed and the `MigrationResult` was discarded — only the
 * initial mount (via `initialState`) ever actually rendered. Changing the `config` prop
 * after mount did nothing.
 *
 * `StudioDashboard.tsx` had zero tests before this file.
 */

function makeSource(id: string, rows: Record<string, unknown>[]): StudioDataSource {
  return {
    id,
    label: id,
    fields: [{ id: 'value', label: 'Value', type: 'string' }],
    rows,
  };
}

function makeConfig(
  textBody: string,
  dataSources: StudioState['runtime']['dataSources'] = {},
): StudioState {
  return createDefaultStudioState({
    doc: {
      widgets: {
        t1: { id: 't1', kind: 'text', title: 'Text', config: { textBody } },
      },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['t1']] },
      },
    },
    runtime: {
      dataSources,
    },
  });
}

describe('StudioDashboard', () => {
  it('renders the initial `config` on mount', async () => {
    const config = makeConfig('Hello from config A');
    render(<StudioDashboard config={config} />);

    expect(await screen.findByText('Hello from config A')).not.toBe(null);
  });

  it('re-renders the dashboard when the `config` prop changes by reference', async () => {
    const configA = makeConfig('Hello from config A');
    const configB = makeConfig('Hello from config B');

    const { setProps } = render(<StudioDashboard config={configA} />);
    expect(await screen.findByText('Hello from config A')).not.toBe(null);

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('Hello from config B')).not.toBe(null);
    expect(screen.queryByText('Hello from config A')).toBe(null);
  });

  // The two halves of the "compare by reference, not deep equality" contract documented on
  // the `config` prop (`StudioDashboard.tsx`'s reload guard is `prevConfigRef.current !==
  // config`). Both cases are asserted here because only one of them used to be: this file
  // previously carried a single case titled "does NOT reload when the config prop is set to
  // an equal-but-different object on every render", whose body passed the SAME reference —
  // advertising a deep-equality guarantee the component does not provide.
  //
  // Reload is observed through state identity: `loadSerializedState` calls `commitState`,
  // which replaces the whole state object, and nothing else in the swap effect can change it
  // for a config carrying no data sources.
  it('re-rendering with the same config reference is a no-op', async () => {
    const config = makeConfig('Stable content');
    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(<StudioDashboard ref={ref} config={config} />);
    expect(await screen.findByText('Stable content')).not.toBe(null);

    const stateBefore = ref.current!.getState();
    await act(async () => {
      setProps({ config });
    });
    expect(ref.current!.getState()).toBe(stateBefore);
  });

  it('DOES reload when an equal-but-different config object is passed (reference comparison)', async () => {
    // Documented, deliberate consequence of comparing by reference: a host that rebuilds its
    // config object inline on every render reloads the dashboard every render. Hosts must
    // hold the object stable (`useMemo`/module constant) — which is exactly why the contract
    // needs a test that pins the real behaviour rather than one implying the opposite.
    const configA = makeConfig('Stable content');
    const configB = makeConfig('Stable content');
    expect(configB).not.toBe(configA);
    expect(configB).toEqual(configA);

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(<StudioDashboard ref={ref} config={configA} />);
    expect(await screen.findByText('Stable content')).not.toBe(null);

    const stateBefore = ref.current!.getState();
    await act(async () => {
      setProps({ config: configB });
    });

    expect(ref.current!.getState()).not.toBe(stateBefore);
    // The content is unchanged, so the reload is invisible to the user — only the discarded
    // in-app state (and the reset undo history) reveals it.
    expect(await screen.findByText('Stable content')).not.toBe(null);
  });

  it("upserts the new config's data sources after a reload, instead of dropping them", async () => {
    const sourceA = makeSource('orders', [{ value: 'a' }]);
    const sourceB = makeSource('customers', [{ value: 'b' }]);
    const configA = makeConfig('A', { orders: sourceA });
    const configB = makeConfig('B', { customers: sourceB });

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(<StudioDashboard ref={ref} config={configA} />);
    expect(await screen.findByText('A')).not.toBe(null);
    expect(ref.current!.getState().runtime.dataSources.orders).toBeTruthy();

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('B')).not.toBe(null);
    const stateAfter = ref.current!.getState();
    // The new config's data source must be present …
    expect(stateAfter.runtime.dataSources.customers).toBeTruthy();
    expect(stateAfter.runtime.dataSources.customers.rows).toEqual([{ value: 'b' }]);
  });

  it('prunes data sources the new config no longer contains, instead of leaking them (2.1)', async () => {
    // Regression (2.1): `loadSerializedState` preserves the PREVIOUS controller's entire
    // `runtime.dataSources`, and the swap effect only upserts the new config's sources — so a
    // source dropped from the new config survived forever (and kept the date-range bar minting
    // a dashboard-date-range filter for it).
    const configA = makeConfig('A', {
      orders: makeSource('orders', [{ value: 'a' }]),
      customers: makeSource('customers', [{ value: 'c' }]),
    });
    const configB = makeConfig('B', { orders: makeSource('orders', [{ value: 'b' }]) });

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(<StudioDashboard ref={ref} config={configA} />);
    expect(await screen.findByText('A')).not.toBe(null);
    expect(ref.current!.getState().runtime.dataSources.customers).toBeTruthy();

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('B')).not.toBe(null);
    const stateAfter = ref.current!.getState();
    // The source dropped from config B is gone; the surviving source has config B's rows.
    expect(stateAfter.runtime.dataSources.customers).toBeUndefined();
    expect(stateAfter.runtime.dataSources.orders).toBeTruthy();
    expect(stateAfter.runtime.dataSources.orders.rows).toEqual([{ value: 'b' }]);
  });

  it('preserves adapters registered via `dataAdapters` across a `config` prop swap (1.8)', async () => {
    // Regression (1.8): adapters registered through the `dataAdapters` prop
    // (→ `setDataSourceAdapter`) were silently wiped when the `config` prop changed. The
    // swap effect re-injects each source from `config.runtime.dataSources` — sources parsed
    // from `serializeState()`/JSON that never carry an `adapter` field — and `upsertDataSource`
    // replaced the whole entry, so adapter-backed sources fell back to static rows and widgets
    // went blank. The adapter-registration effect (deps `[dataAdapters]`) does not re-run on a
    // `config` change, so nothing re-attached them.
    const adapter: StudioDataSourceAdapter = {
      getRows: async () => ({ rows: [{ value: 'live' }], totalCount: 1 }),
    };
    // Both configs describe the same 'orders' source but WITHOUT an adapter (JSON has none).
    const configA = makeConfig('A', { orders: makeSource('orders', [{ value: 'a' }]) });
    const configB = makeConfig('B', { orders: makeSource('orders', [{ value: 'b' }]) });

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(
      <StudioDashboard ref={ref} config={configA} dataAdapters={{ orders: adapter }} />,
    );
    expect(await screen.findByText('A')).not.toBe(null);
    // The adapter was attached to the 'orders' source on mount.
    expect(ref.current!.getState().runtime.dataSources.orders.adapter).toBe(adapter);

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('B')).not.toBe(null);
    const stateAfter = ref.current!.getState();
    // The adapter survives the config swap (was previously wiped), and the new static rows
    // from config B are applied.
    expect(stateAfter.runtime.dataSources.orders.adapter).toBe(adapter);
    expect(stateAfter.runtime.dataSources.orders.rows).toEqual([{ value: 'b' }]);
  });

  it('registers an adapter for a source a config swap INTRODUCES, with a referentially stable `dataAdapters` map (1.1)', async () => {
    // Regression (1.1): the `dataAdapters` registration effect only runs on `[dataAdapters]`
    // identity change, and `setDataSourceAdapter` no-ops when the source doesn't exist yet.
    // A host that keeps a STABLE `dataAdapters` map (as the docs steer them toward, to satisfy
    // `setDataSourceAdapter`'s same-adapter no-op guard) but swaps in a config that ADDS a new
    // source got that source installed adapter-less: the mount-time registration no-op'd (source
    // absent), and the adapters effect never re-fires. The source's widgets then silently render
    // from (absent) static rows. The config-swap effect must re-apply the current adapters after
    // upserting the new config's sources.
    const ordersAdapter: StudioDataSourceAdapter = {
      getRows: async () => ({ rows: [{ value: 'orders-live' }], totalCount: 1 }),
    };
    const customersAdapter: StudioDataSourceAdapter = {
      getRows: async () => ({ rows: [{ value: 'customers-live' }], totalCount: 1 }),
    };
    // Referentially STABLE across both renders — the host never passes a fresh map.
    const dataAdapters = { orders: ordersAdapter, customers: customersAdapter };

    // Config A uses only 'orders'; 'customers' does not exist yet, so its adapter no-ops at mount.
    const configA = makeConfig('A', { orders: makeSource('orders', [{ value: 'a' }]) });
    // Config B introduces the 'customers' source.
    const configB = makeConfig('B', {
      orders: makeSource('orders', [{ value: 'b' }]),
      customers: makeSource('customers', [{ value: 'c' }]),
    });

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(
      <StudioDashboard ref={ref} config={configA} dataAdapters={dataAdapters} />,
    );
    expect(await screen.findByText('A')).not.toBe(null);
    // 'customers' doesn't exist yet at mount.
    expect(ref.current!.getState().runtime.dataSources.customers).toBeUndefined();

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('B')).not.toBe(null);
    const stateAfter = ref.current!.getState();
    // The newly introduced source exists AND has its adapter registered (previously it was
    // installed adapter-less, falling back to static rows).
    expect(stateAfter.runtime.dataSources.customers).toBeTruthy();
    expect(stateAfter.runtime.dataSources.customers.adapter).toBe(customersAdapter);
    // The pre-existing source keeps its adapter too.
    expect(stateAfter.runtime.dataSources.orders.adapter).toBe(ordersAdapter);
  });
});
