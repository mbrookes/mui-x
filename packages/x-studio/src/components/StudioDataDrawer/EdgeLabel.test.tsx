import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { EdgeLabel } from './EdgeLabel';
import type { NodeLayout } from './edgeGeometry';

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

function setup(rel: StudioRelationship, sources: Record<string, StudioDataSource> = DATA_SOURCES) {
  const { wrapper } = createStudioHarness();
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
});
