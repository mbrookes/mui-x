import { describe, it, expect } from 'vitest';
import { moveWidgetInLayout } from './widgetLayoutMove';

describe('moveWidgetInLayout', () => {
  it('returns null when the widget is not present', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'z', 'left')).toBe(null);
  });

  it('swaps with the left neighbour', () => {
    expect(moveWidgetInLayout([['a', 'b', 'c']], 'b', 'left')).toEqual([['b', 'a', 'c']]);
  });

  it('swaps with the right neighbour', () => {
    expect(moveWidgetInLayout([['a', 'b', 'c']], 'b', 'right')).toEqual([['a', 'c', 'b']]);
  });

  it('returns null moving left from the first column', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'a', 'left')).toBe(null);
  });

  it('returns null moving right from the last column', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'b', 'right')).toBe(null);
  });

  it('moves up into the previous row and drops the emptied row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'b', 'up')).toEqual([['a', 'b']]);
  });

  it('moves down into the next row and drops the emptied row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'a', 'down')).toEqual([['b', 'a']]);
  });

  it('moves up into a new top row when in the first (multi-widget) row', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'b', 'up')).toEqual([['b'], ['a']]);
  });

  it('moves down into a new bottom row when in the last (multi-widget) row', () => {
    expect(moveWidgetInLayout([['a', 'b']], 'a', 'down')).toEqual([['b'], ['a']]);
  });

  it('returns null moving up when alone in the first row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'a', 'up')).toBe(null);
  });

  it('returns null moving down when alone in the last row', () => {
    expect(moveWidgetInLayout([['a'], ['b']], 'b', 'down')).toBe(null);
  });

  it('does not mutate the input layout', () => {
    const rows = [['a', 'b']];
    moveWidgetInLayout(rows, 'a', 'right');
    expect(rows).toEqual([['a', 'b']]);
  });
});
