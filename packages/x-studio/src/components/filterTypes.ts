export type RelativeDateUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

/** A date value expressed relative to "now" at evaluation time, e.g. "5 days ago". */
export interface RelativeDateValue {
  relative: true;
  amount: number;
  unit: RelativeDateUnit;
  direction: 'past' | 'next';
}
