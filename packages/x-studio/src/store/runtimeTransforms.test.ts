import { describe, it, expect } from 'vitest';
import type { StudioRuntime, StudioDataSource, StudioDataSourceAdapter } from '../models';
import {
  upsertDataSource,
  removeDataSource,
  patchDataSource,
  updateDataSourceField,
} from './runtimeTransforms';

/**
 * The runtime transforms, tested directly.
 *
 * Every assertion here is about the NO-OP CONTRACT — that a transform which declines returns the
 * SAME runtime object. `StudioController.commitRuntime` keys entirely off that reference, so a
 * transform that rebuilt on a logical no-op would notify every subscriber for nothing, and no
 * controller-level test would notice: the state is value-identical either way.
 */
const source = (id: string, over?: Partial<StudioDataSource>): StudioDataSource =>
  ({ id, label: id, fields: [], rows: [], ...over }) as StudioDataSource;

const runtime = (...sources: StudioDataSource[]): StudioRuntime =>
  ({
    dataSources: Object.fromEntries(sources.map((s) => [s.id, s])),
  }) as StudioRuntime;

describe('runtimeTransforms — upsertDataSource', () => {
  it('inserts a new source', () => {
    const before = runtime();
    const after = upsertDataSource(before, source('sales'));
    expect(after).not.toBe(before);
    expect(after.dataSources.sales.id).toBe('sales');
  });

  it('preserves a separately-registered adapter the incoming source omits', () => {
    const adapter = { getRows: async () => ({ rows: [] }) } as unknown as StudioDataSourceAdapter;
    const before = runtime(source('sales', { adapter }));
    // A config produced by `serializeState()`/JSON never carries an adapter. Dropping it here is
    // what would make every adapter-backed widget silently fall back to (absent) static rows.
    const after = upsertDataSource(before, source('sales', { label: 'Renamed' }));
    expect(after.dataSources.sales.adapter).toBe(adapter);
    expect(after.dataSources.sales.label).toBe('Renamed');
  });

  it('lets an incoming adapter win over the registered one', () => {
    const oldAdapter = {
      getRows: async () => ({ rows: [] }),
    } as unknown as StudioDataSourceAdapter;
    const newAdapter = {
      getRows: async () => ({ rows: [] }),
    } as unknown as StudioDataSourceAdapter;
    const after = upsertDataSource(
      runtime(source('sales', { adapter: oldAdapter })),
      source('sales', { adapter: newAdapter }),
    );
    expect(after.dataSources.sales.adapter).toBe(newAdapter);
  });

  it('is a no-op for the identical source object', () => {
    const s = source('sales');
    const before = runtime(s);
    expect(upsertDataSource(before, s)).toBe(before);
  });
});

describe('runtimeTransforms — removeDataSource', () => {
  it('drops the named source', () => {
    const after = removeDataSource(runtime(source('a'), source('b')), 'a');
    expect(Object.keys(after.dataSources)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', () => {
    const before = runtime(source('a'));
    expect(removeDataSource(before, 'nope')).toBe(before);
  });

  it('does not treat an inherited key as a source', () => {
    // `dataSources.constructor` is a truthy FUNCTION off `Object.prototype`. Without the own-key
    // guard this would report a hit and rebuild the record around a prototype member.
    const before = runtime(source('a'));
    expect(removeDataSource(before, 'constructor')).toBe(before);
    expect(removeDataSource(before, 'toString')).toBe(before);
  });
});

describe('runtimeTransforms — patchDataSource', () => {
  it('merges the patch', () => {
    const after = patchDataSource(runtime(source('a')), 'a', { label: 'New' });
    expect(after.dataSources.a.label).toBe('New');
  });

  it('is a no-op when every patched key already holds its incoming value', () => {
    const rows = [{ x: 1 }];
    const before = runtime(source('a', { rows }));
    // The host-poller case: re-injecting the SAME rows array must not churn subscribers.
    expect(patchDataSource(before, 'a', { rows })).toBe(before);
  });

  it('is a no-op for an unknown id, and for an inherited key', () => {
    const before = runtime(source('a'));
    expect(patchDataSource(before, 'nope', { label: 'x' })).toBe(before);
    expect(patchDataSource(before, 'constructor', { label: 'x' })).toBe(before);
  });
});

describe('runtimeTransforms — updateDataSourceField', () => {
  const withFields = () =>
    runtime(
      source('a', {
        fields: [
          { id: 'f1', label: 'One', type: 'string' },
          { id: 'f2', label: 'Two', type: 'number' },
        ],
      } as Partial<StudioDataSource>),
    );

  it('updates only the named field', () => {
    const before = withFields();
    const after = updateDataSourceField(before, 'a', 'f1', { label: 'Renamed' });
    expect(after.dataSources.a.fields[0].label).toBe('Renamed');
    // The untouched field keeps its object identity, so memoized consumers of it do not rerender.
    expect(after.dataSources.a.fields[1]).toBe(before.dataSources.a.fields[1]);
  });

  it('is a no-op for an unknown field id', () => {
    const before = withFields();
    expect(updateDataSourceField(before, 'a', 'nope', { label: 'x' })).toBe(before);
  });

  it('is a no-op for a value-identical update', () => {
    const before = withFields();
    expect(updateDataSourceField(before, 'a', 'f1', { label: 'One' })).toBe(before);
  });

  it('is a no-op for an unknown source', () => {
    const before = withFields();
    expect(updateDataSourceField(before, 'nope', 'f1', { label: 'x' })).toBe(before);
  });
});
