import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { EdgeLabel } from './EdgeLabel';
import { bezierMidpoint, buildEdgeGeometry, type NodeLayout } from './edgeGeometry';

const { render } = createRenderer();

const SRC_NODE: NodeLayout = { id: 'orders', label: 'Orders', x: 0, y: 0, width: 120, height: 40 };
const TGT_NODE: NodeLayout = {
  id: 'customers',
  label: 'Customers',
  x: 200,
  y: 0,
  width: 120,
  height: 40,
};

const DATA_SOURCES: Record<string, StudioDataSource> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'customerId', label: 'Customer', type: 'string' }],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'id', label: 'ID', type: 'string' }],
  },
};

const REL: StudioRelationship = {
  id: 'r1',
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-one',
};

function setup(
  rel: StudioRelationship,
  sources: Record<string, StudioDataSource> = DATA_SOURCES,
  harnessOptions?: Parameters<typeof createStudioHarness>[0],
) {
  const { wrapper } = createStudioHarness(harnessOptions);
  return render(
    <svg>
      <EdgeLabel
        rel={rel}
        srcNode={SRC_NODE}
        tgtNode={TGT_NODE}
        sources={sources}
        color="black"
        hoverColor="blue"
      />
    </svg>,
    { wrapper },
  );
}

describe('EdgeLabel', () => {
  it('renders a well-formed relationship without throwing', () => {
    expect(() => setup(REL)).not.toThrow();
    expect(screen.getByText('N:1')).not.toBe(null);
  });

  // Prototype-chain lookup bugs: `sources[rel.sourceId]` and `TYPE_LABELS[rel.type]` are plain
  // object bracket lookups. A doc-authored `rel.sourceId`/`rel.type` equal to an inherited
  // `Object.prototype` member name (e.g. "constructor") resolves the inherited function instead
  // of `undefined`, which previously either crashed on `.find()` off an `undefined` `.fields`
  // property or rendered a function as an SVG `<text>` child.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.sourceId is the prototype key %s',
    (key) => {
      const hostileRel: StudioRelationship = { ...REL, sourceId: key };
      expect(() => setup(hostileRel, DATA_SOURCES)).not.toThrow();
    },
  );

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.targetId is the prototype key %s',
    (key) => {
      const hostileRel: StudioRelationship = { ...REL, targetId: key };
      expect(() => setup(hostileRel, DATA_SOURCES)).not.toThrow();
    },
  );

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'renders without throwing when rel.type is the prototype key %s',
    (key) => {
      const hostileRel = { ...REL, type: key } as unknown as StudioRelationship;
      expect(() => setup(hostileRel, DATA_SOURCES)).not.toThrow();
      // The malformed type falls back to being rendered as its own string, never as a function.
      expect(screen.getByText(key)).not.toBe(null);
    },
  );

  it('renders without throwing when rel.junctionSourceId is a prototype key and the popover is opened', async () => {
    const hostileRel: StudioRelationship = {
      ...REL,
      type: 'many-to-many',
      junctionSourceId: 'constructor',
    };
    const { user } = setup(hostileRel);
    await user.click(screen.getAllByRole('button')[0]);
    // The junction source falls back to being rendered as its own ID string, never as a function.
    expect(screen.getByText(/constructor/)).not.toBe(null);
  });

  // The badge used to be positioned from a private copy of `buildEdgePath`'s branch
  // selection. Both now come from one `buildEdgeGeometry` call, so the badge and its
  // click/keyboard target always sit on the rendered curve.
  describe('badge placement', () => {
    it.each([
      ['source left of target', { x: 200, y: 0 }],
      ['source right of target', { x: -400, y: 0 }],
      ['source above target', { x: 0, y: 200 }],
      ['source below target (fallback)', { x: 0, y: -200 }],
    ] as Array<[string, { x: number; y: number }]>)(
      'places the badge on the rendered path (%s)',
      (_label, tgtPosition) => {
        const tgtNode: NodeLayout = { ...TGT_NODE, ...tgtPosition };
        const { wrapper } = createStudioHarness();
        const { container } = render(
          <svg>
            <EdgeLabel
              rel={REL}
              srcNode={SRC_NODE}
              tgtNode={tgtNode}
              sources={DATA_SOURCES}
              color="black"
              hoverColor="blue"
            />
          </svg>,
          { wrapper },
        );

        const geometry = buildEdgeGeometry(SRC_NODE, tgtNode);
        const mid = bezierMidpoint(
          geometry.s.x,
          geometry.s.y,
          geometry.cp1.x,
          geometry.cp1.y,
          geometry.cp2.x,
          geometry.cp2.y,
          geometry.t.x,
          geometry.t.y,
        );

        // The visible edge is the geometry's own path …
        const paths = Array.from(container.querySelectorAll('path'));
        expect(paths.length).toBeGreaterThan(0);
        paths.forEach((p) => expect(p.getAttribute('d')).toBe(geometry.d));

        // … and the badge sits at that same curve's midpoint.
        const text = screen.getByText('N:1');
        expect(Number(text.getAttribute('x'))).toBeCloseTo(mid.x);
        expect(Number(text.getAttribute('y'))).toBeCloseTo(mid.y + 4);
      },
    );
  });

  // ── Accessible name localisation ────────────────────────────────────────────
  //
  // The edge badge's accessible name used to be built as `` `${src} to ${tgt}, ${rel.type}` ``:
  // a hardcoded English connector plus the raw enum value, so a screen reader under any other
  // locale announced this control half-untranslated. It is now composed entirely from locale
  // text that every bundled locale already ships.
  describe('accessible name', () => {
    it('uses the human-readable relationship type, not the raw enum value', () => {
      setup(REL);

      const badge = screen.getAllByRole('button')[0];
      const label = badge.getAttribute('aria-label') ?? '';
      expect(label).toContain('Orders');
      expect(label).toContain('Customers');
      expect(label).toContain('Many-to-one');
      expect(label).not.toContain('many-to-one');
      // The English-only connector is gone.
      expect(label).not.toContain(' to ');
    });

    it('translates the accessible name under a non-English locale', async () => {
      const { frLocaleText } = await import('../../locales/fr');
      setup(REL, DATA_SOURCES, { providerProps: { localeText: frLocaleText } });

      const label = screen.getAllByRole('button')[0].getAttribute('aria-label') ?? '';
      expect(label).toContain(frLocaleText.relationshipTypeManyToOne!);
      expect(label).not.toContain('many-to-one');
    });

    it('falls back to the raw type for an unknown relationship type', () => {
      const unknownRel = { ...REL, type: 'weird-type' } as unknown as StudioRelationship;
      setup(unknownRel);

      expect(screen.getAllByRole('button')[0].getAttribute('aria-label')).toContain('weird-type');
    });
  });
});
