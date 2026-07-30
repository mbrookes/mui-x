import { describe, expect, it } from 'vitest';
import {
  OPTIONAL_STUDIO_WIDGET_FIELDS,
  OPTIONAL_WIDGET_STRING_FIELDS,
  REQUIRED_STUDIO_WIDGET_FIELDS,
  STUDIO_CHART_TYPES,
  STUDIO_EXPRESSION_OPERATORS,
  STUDIO_FILTER_OPERATORS,
  STUDIO_RELATIONSHIP_TYPES,
  STUDIO_WIDGET_FIELDS,
  WIDGET_OTHER_FIELDS,
  WIDGET_STRING_FIELDS,
  WIDGET_TITLE_MODE_FIELDS,
  isStudioChartType,
  isStudioExpressionOperator,
  isStudioFilterOperator,
  isStudioRelationshipType,
} from './widgetTypeGuards';

// The closed unions this file publishes runtime lists for are each gated at a trust
// boundary, so "the list agrees with the union" is a compile-time lock (the
// `AssertAll…Listed` error tuples) and "the predicate agrees with the list" is what these
// tests pin. Completeness itself cannot be asserted at runtime — a TypeScript union has no
// runtime representation — which is exactly why the compile-time locks exist.
//
// What CAN be pinned at runtime, and is below, is the list's LENGTH. A length pin is the
// runtime counterpart of the compile lock and catches the one thing the lock cannot: a list
// that loses entries while the union loses them too (e.g. a union member deleted by
// accident during a refactor compiles cleanly with the list shortened to match). It also
// makes the "closed N-member union" claims in the docs falsifiable.

describe('closed-union list lengths', () => {
  it.each([
    ['STUDIO_CHART_TYPES', STUDIO_CHART_TYPES as readonly string[], 16],
    ['STUDIO_FILTER_OPERATORS', STUDIO_FILTER_OPERATORS as readonly string[], 17],
    ['STUDIO_EXPRESSION_OPERATORS', STUDIO_EXPRESSION_OPERATORS as readonly string[], 22],
    ['STUDIO_RELATIONSHIP_TYPES', STUDIO_RELATIONSHIP_TYPES as readonly string[], 3],
  ])('%s lists exactly %i members', (_name, list, expected) => {
    expect(list).toHaveLength(expected);
  });
});

describe('isStudioExpressionOperator', () => {
  // NOTE: there is deliberately no `it.each(STUDIO_EXPRESSION_OPERATORS)('accepts …')` block
  // here. `isStudioExpressionOperator` IS `list.includes(value)`, so asserting
  // `includes(x) === true` for every `x` drawn from that same list is a tautology: it cannot
  // fail, and it would keep passing if the list lost half its entries. The length pin above
  // and the compile lock in the source are what actually hold the list; the rejection cases
  // below are what actually exercise the predicate.

  it.each([
    // Plausible near-misses a hand-edited or foreign persisted doc carries.
    'pow',
    'concat',
    'notEquals',
    'greaterThanOrEquals',
    'ADD',
    '',
  ])('rejects the unknown operator "%s"', (operator) => {
    expect(isStudioExpressionOperator(operator)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { operator: 'add' }],
    ['an array', ['add']],
  ])('rejects %s', (_label, value) => {
    expect(isStudioExpressionOperator(value)).toBe(false);
  });

  it('resolves nothing up the prototype chain', () => {
    // `Array.prototype.includes` walks indices, never the prototype — pinned because the
    // input is untrusted persisted data and an inherited `Object.prototype` member name
    // resolving to `true` would fail this closed union OPEN.
    expect(isStudioExpressionOperator('toString')).toBe(false);
    expect(isStudioExpressionOperator('constructor')).toBe(false);
    expect(isStudioExpressionOperator('__proto__')).toBe(false);
  });

  it('lists each operator exactly once', () => {
    expect(new Set(STUDIO_EXPRESSION_OPERATORS).size).toBe(STUDIO_EXPRESSION_OPERATORS.length);
  });
});

// The two pre-existing lists get the same duplicate/prototype pins, so all the closed
// unions are held to one standard rather than only the newest one.
describe('the sibling closed-union lists', () => {
  it.each([
    ['STUDIO_CHART_TYPES', STUDIO_CHART_TYPES as readonly string[]],
    ['STUDIO_FILTER_OPERATORS', STUDIO_FILTER_OPERATORS as readonly string[]],
    ['STUDIO_RELATIONSHIP_TYPES', STUDIO_RELATIONSHIP_TYPES as readonly string[]],
  ])('%s lists each member exactly once', (_name, list) => {
    expect(new Set(list).size).toBe(list.length);
  });

  it('no membership test resolves a prototype member', () => {
    expect(isStudioChartType('constructor')).toBe(false);
    expect(isStudioFilterOperator('constructor')).toBe(false);
    expect(isStudioRelationshipType('constructor')).toBe(false);
  });
});

// Near-miss rejection coverage for the two lists that had none. Both gate a fail-OPEN
// defect rather than a crash — an unknown `chartType` renders a blank/default chart and
// wedges the next AI `update_widget`; an unknown `operator` renders a chip that looks ACTIVE
// while filtering nothing — so the values below are exactly the plausible typos a
// hand-edited or foreign doc carries, not adversarial junk.
describe('isStudioChartType', () => {
  it.each([
    'donut-chart', // a plausible spelling of the real 'donut'
    'bar-chart',
    'trendline', // named in the load-boundary comment as the motivating example
    'Bar',
    'bar100', // the real member is 'bar-100'
    'stacked-bar', // the real member is 'bar-stacked'
    '',
  ])('rejects the unknown chart type "%s"', (chartType) => {
    expect(isStudioChartType(chartType)).toBe(false);
  });
});

describe('isStudioFilterOperator', () => {
  it.each([
    'equal', // named in the load-boundary comment as the motivating typo for 'equals'
    'not_equal', // the real member is 'not_equals'
    'notEquals', // the EXPRESSION-operator spelling, on the filter list
    'startsWith', // the real member is 'starts_with'
    'EQUALS',
    '',
  ])('rejects the unknown filter operator "%s"', (operator) => {
    expect(isStudioFilterOperator(operator)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', ['equals']],
  ])('rejects %s', (_label, value) => {
    expect(isStudioFilterOperator(value)).toBe(false);
  });
});

describe('isStudioRelationshipType', () => {
  it.each([
    'many_to_one', // underscores, not hyphens
    'one-to-many', // not a member — the schema models it as 'many-to-one' from the far side
    'many-to-many-through',
    '',
  ])('rejects the unknown relationship type "%s"', (type) => {
    expect(isStudioRelationshipType(type)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(isStudioRelationshipType(value)).toBe(false);
  });
});

// The `StudioWidgetOf` field lists are the single source five screening sites derive from
// (the reducer's mergeable-key allow-list and `unsetFields` denylist, the shared
// optional-scalar screen, and the wire boundary's `updateWidget.changes` checks). The
// partitions and the optional/required split are compile-locked; these pin the DERIVED
// values, since a derivation bug would silently un-screen a field with nothing to compile
// against.
describe('widget field lists', () => {
  it('partitions every widget field exactly once', () => {
    expect(new Set(STUDIO_WIDGET_FIELDS).size).toBe(STUDIO_WIDGET_FIELDS.length);
    expect([...STUDIO_WIDGET_FIELDS].sort()).toEqual(
      [...WIDGET_OTHER_FIELDS, ...WIDGET_STRING_FIELDS, ...WIDGET_TITLE_MODE_FIELDS].sort(),
    );
  });

  it('derives required = all fields minus optional', () => {
    expect([...REQUIRED_STUDIO_WIDGET_FIELDS].sort()).toEqual(['config', 'id', 'kind', 'title']);
    expect([...OPTIONAL_STUDIO_WIDGET_FIELDS].sort()).toEqual([
      'sourceId',
      'subtitle',
      'subtitleMode',
      'titleMode',
    ]);
    // Disjoint and exhaustive against the full list.
    expect([...REQUIRED_STUDIO_WIDGET_FIELDS, ...OPTIONAL_STUDIO_WIDGET_FIELDS].sort()).toEqual(
      [...STUDIO_WIDGET_FIELDS].sort(),
    );
  });

  it('derives the optional string fields as the intersection of the two lists', () => {
    expect([...OPTIONAL_WIDGET_STRING_FIELDS].sort()).toEqual(['sourceId', 'subtitle']);
  });
});

// R3-F7: `STUDIO_RELATIONSHIP_TYPES`/`isStudioRelationshipType` were the only one of the
// four compile-locked closed-union lists NOT re-exported from the package index, while
// ARCHITECTURE.md's "publishing the list, not just the type, is the whole point" argument
// applies to all four equally. Asserted against the PUBLIC entry point, so the pin fails if
// the re-export is ever dropped.
describe('all four closed-union runtime lists are published from the package index (R3-F7)', () => {
  it('exports every list and its predicate, all four identical to the source module', async () => {
    const publicApi = await import('./index');
    const pairs = [
      ['STUDIO_CHART_TYPES', 'isStudioChartType', STUDIO_CHART_TYPES, isStudioChartType],
      [
        'STUDIO_FILTER_OPERATORS',
        'isStudioFilterOperator',
        STUDIO_FILTER_OPERATORS,
        isStudioFilterOperator,
      ],
      [
        'STUDIO_EXPRESSION_OPERATORS',
        'isStudioExpressionOperator',
        STUDIO_EXPRESSION_OPERATORS,
        isStudioExpressionOperator,
      ],
      [
        'STUDIO_RELATIONSHIP_TYPES',
        'isStudioRelationshipType',
        STUDIO_RELATIONSHIP_TYPES,
        isStudioRelationshipType,
      ],
    ] as const;
    for (const [listName, predicateName, list, predicate] of pairs) {
      expect(publicApi, `${listName} must be published`).toHaveProperty(listName);
      expect(publicApi, `${predicateName} must be published`).toHaveProperty(predicateName);
      // Same binding, not a re-declared copy — the whole point of publishing the list.
      expect((publicApi as Record<string, unknown>)[listName]).toBe(list);
      expect((publicApi as Record<string, unknown>)[predicateName]).toBe(predicate);
    }
  });
});
