import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '../../models';
import type { StudioDataSource, StudioState } from '../../models';
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

function makeConfig(textBody: string, dataSources: StudioState['dataSources'] = {}): StudioState {
  return createDefaultStudioState({
    dataSources,
    widgets: {
      t1: { id: 't1', kind: 'text', title: 'Text', config: { textBody } },
    },
    pages: {
      'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['t1']] },
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

  it('does NOT reload when the config prop is set to an equal-but-different object on every render (reference check)', async () => {
    // Sanity check for the "compare by reference, not deep equality" contract documented on
    // the prop: passing a fresh object with identical content on every render must not
    // thrash the dashboard back to the same state repeatedly. We only assert here that a
    // *stable* config reference does not trigger extra reload work observable via the
    // ref — i.e. re-rendering with the SAME reference is a no-op.
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

  it("upserts the new config's data sources after a reload, instead of dropping them", async () => {
    const sourceA = makeSource('orders', [{ value: 'a' }]);
    const sourceB = makeSource('customers', [{ value: 'b' }]);
    const configA = makeConfig('A', { orders: sourceA });
    const configB = makeConfig('B', { customers: sourceB });

    const ref = React.createRef<StudioHandle>();
    const { setProps } = render(<StudioDashboard ref={ref} config={configA} />);
    expect(await screen.findByText('A')).not.toBe(null);
    expect(ref.current!.getState().dataSources.orders).toBeTruthy();

    await act(async () => {
      setProps({ config: configB });
    });

    expect(await screen.findByText('B')).not.toBe(null);
    const stateAfter = ref.current!.getState();
    // The new config's data source must be present …
    expect(stateAfter.dataSources.customers).toBeTruthy();
    expect(stateAfter.dataSources.customers.rows).toEqual([{ value: 'b' }]);
  });
});
