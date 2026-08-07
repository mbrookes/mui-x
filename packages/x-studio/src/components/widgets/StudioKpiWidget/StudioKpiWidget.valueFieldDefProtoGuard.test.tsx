import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../../models';
import { resolveKpiValueFieldDef } from './StudioKpiWidget';

// ─── Prototype-chain key lookup guard on `dataSources[ownerSourceId]` (architecture
// review finding) ────────────────────────────────────────────────────────────────
//
// `resolveKpiValueFieldDef`'s fallback branch traces the value field's owning source via
// `analyzeChartSupport`'s `fieldOwners` map (built from doc-authored relationships), then
// indexes `dataSources` with the resulting id. Since that id is ultimately traced from a
// `StudioRelationship`, a hostile/AI-authored relationship could make it come out equal to
// an `Object.prototype` member name ("constructor", "toString", …). Before the fix, a bare
// `dataSources[ownerSourceId]` would then resolve the inherited `Object.prototype.constructor`
// function instead of `undefined` when no such source actually exists at runtime — a truthy,
// non-source value that slips past the `?.fields` guard and crashes on `.find(...)`.
//
// Driving this scenario through the real `analyzeChartSupport`/relationship graph is not
// possible without first tripping an unrelated, out-of-scope bare lookup inside
// `chartSupport.ts`'s own `hasRowLevelField` — so `analyzeChartSupport` is stubbed here to
// return the malicious owner id directly, isolating exactly the one guarded line this fix
// touches (`StudioKpiWidget.tsx`, `resolveKpiValueFieldDef`).
vi.mock('@mui/x-studio-core/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/x-studio-core/engine')>();
  return {
    ...actual,
    analyzeChartSupport: vi.fn(() => ({
      supported: true,
      fieldOwners: new Map([['metric', 'constructor']]),
      anchorSourceId: 'constructor',
    })),
  };
});

describe('resolveKpiValueFieldDef — prototype-chain key lookup guard', () => {
  it('does not throw and returns undefined when the traced owning sourceId is an Object.prototype member name with no matching runtime source', () => {
    const dataSource: StudioDataSource = {
      id: 'sales',
      label: 'Sales',
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
      rows: [],
    };
    // No "constructor" key present — this is the runtime/doc mismatch the guard defends
    // against (a relationship can reference a related source the host never injected).
    const dataSources: Record<string, StudioDataSource> = { sales: dataSource };

    expect(() => resolveKpiValueFieldDef('metric', dataSource, dataSources, [], [])).not.toThrow();

    const result = resolveKpiValueFieldDef('metric', dataSource, dataSources, [], []);
    expect(result).toBeUndefined();
  });

  it('still resolves correctly when "constructor" is a genuine own-property data source', () => {
    const dataSource: StudioDataSource = {
      id: 'sales',
      label: 'Sales',
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
      rows: [],
    };
    const ownerSource: StudioDataSource = {
      id: 'constructor',
      label: 'Weirdly named source',
      fields: [{ id: 'metric', label: 'Metric', type: 'number', format: 'currency' }],
      rows: [],
    };
    const dataSources: Record<string, StudioDataSource> = {
      sales: dataSource,
      constructor: ownerSource,
    };

    const result = resolveKpiValueFieldDef('metric', dataSource, dataSources, [], []);
    expect(result).toEqual(ownerSource.fields[0]);
  });
});
