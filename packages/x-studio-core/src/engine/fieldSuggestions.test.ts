import { describe, expect, it } from 'vitest';
import type { StudioDataField } from '../models';
import { suggestFieldsForRole } from './fieldSuggestions';

/**
 * Field-mapping suggestions (AG_STUDIO_GAP_ANALYSIS XS-EDIT-003).
 *
 * The pickers already filter by capability, which answers "what is legal here". These answer "what
 * did you probably mean", which is the question a source with forty columns actually poses.
 *
 * The heuristic sees field metadata only — no row data, because the pickers render before any query
 * has run. So most of what matters is the NAMING rules, and most of the value is in the demotions
 * rather than the promotions.
 */

function field(id: string, type: StudioDataField['type'], label?: string): StudioDataField {
  return { id, label: label ?? id, type } as StudioDataField;
}

describe('suggestFieldsForRole', () => {
  it('prefers a quantity-shaped name for a measure', () => {
    const fields = [field('width', 'number'), field('revenue', 'number')];
    expect(suggestFieldsForRole(fields, 'measure')[0]).to.equal('revenue');
  });

  it('demotes an identifier below every other numeric field', () => {
    // The most useful rule here. An id column is numeric, so a type-only filter offers it as a
    // measure — and summing order ids is the canonical meaningless dashboard.
    const fields = [field('order_id', 'number'), field('units', 'number')];
    expect(suggestFieldsForRole(fields, 'measure')).to.deep.equal(['units']);
  });

  it('still suggests an identifier when it is the only numeric field', () => {
    // Demoted, not excluded. A source whose only numeric column is `code` should suggest
    // something rather than nothing, and the user can see it is an id as well as we can.
    const fields = [field('code', 'number'), field('name', 'string')];
    expect(suggestFieldsForRole(fields, 'measure')).to.deep.equal([]);
    // …and as a dimension it is likewise available but never first.
    expect(suggestFieldsForRole([field('code', 'string')], 'dimension')).to.deep.equal([]);
  });

  it('matches a hint as a whole segment, not a substring', () => {
    // `includes('id')` matches "video", "width" and "identity". A substring rule would demote
    // three perfectly good fields on the strength of two letters.
    const fields = [field('video_length', 'number'), field('width', 'number')];
    expect(suggestFieldsForRole(fields, 'measure')).to.deep.equal(['video_length', 'width']);
  });

  it('reads the label as well as the id', () => {
    // A source can carry a technical id with a human label, or the reverse.
    const fields = [field('col_7', 'number', 'Revenue'), field('col_1', 'number', 'Sequence')];
    expect(suggestFieldsForRole(fields, 'measure')[0]).to.equal('col_7');
  });

  it('prefers a primary-looking date for a temporal role', () => {
    const fields = [field('shipped_at', 'date'), field('order_date', 'date')];
    expect(suggestFieldsForRole(fields, 'temporal')[0]).to.equal('order_date');
  });

  it('offers a boolean first as a dimension', () => {
    // The lowest-cardinality dimension there is, so it is the safest first offer — and cardinality
    // is exactly what this heuristic cannot otherwise see.
    const fields = [field('customer_name', 'string'), field('is_active', 'boolean')];
    expect(suggestFieldsForRole(fields, 'dimension')[0]).to.equal('is_active');
  });

  it('never suggests a field the role cannot use', () => {
    const fields = [field('name', 'string'), field('total', 'number')];
    expect(suggestFieldsForRole(fields, 'measure')).to.deep.equal(['total']);
    expect(suggestFieldsForRole(fields, 'temporal')).to.deep.equal([]);
  });

  it('keeps the source order for ties', () => {
    // The declared field order is the closest thing to an intentional ranking that exists, so a
    // tie should not be broken arbitrarily (or alphabetically, which is arbitrary with extra steps).
    const fields = [field('alpha', 'number'), field('beta', 'number')];
    expect(suggestFieldsForRole(fields, 'measure')).to.deep.equal(['alpha', 'beta']);
  });

  it('caps the list so the suggestions stay shorter than the list they sit above', () => {
    const fields = Array.from({ length: 10 }, (_, i) => field(`amount_${i}`, 'number'));
    expect(suggestFieldsForRole(fields, 'measure')).to.have.length(3);
    expect(suggestFieldsForRole(fields, 'measure', 1)).to.have.length(1);
  });

  it('returns nothing rather than padding when nothing scores', () => {
    expect(suggestFieldsForRole([], 'dimension')).to.deep.equal([]);
  });
});
