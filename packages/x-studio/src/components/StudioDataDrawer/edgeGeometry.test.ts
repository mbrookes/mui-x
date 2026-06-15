import { describe, expect, it } from 'vitest';
import {
  TYPE_LABELS,
  rightMid,
  leftMid,
  bottomMid,
  topMid,
  buildEdgePath,
  bezierMidpoint,
  type NodeLayout,
} from './edgeGeometry';

function node(x: number, y: number, width = 10, height = 10): NodeLayout {
  return { id: 'n', label: 'n', x, y, width, height };
}

describe('edge anchor helpers', () => {
  const n = node(0, 0, 20, 10);
  it('computes the four edge midpoints', () => {
    expect(rightMid(n)).toEqual({ x: 20, y: 5 });
    expect(leftMid(n)).toEqual({ x: 0, y: 5 });
    expect(bottomMid(n)).toEqual({ x: 10, y: 10 });
    expect(topMid(n)).toEqual({ x: 10, y: 0 });
  });
});

describe('buildEdgePath', () => {
  it('connects right→left when the source is to the left of the target', () => {
    const path = buildEdgePath(node(0, 0), node(100, 0));
    // s = rightMid(src) {10,5}, t = leftMid(tgt) {100,5}, dx = 45
    expect(path).toBe('M 10 5 C 55 5, 55 5, 100 5');
  });

  it('connects left→right when the source is to the right of the target', () => {
    const path = buildEdgePath(node(100, 0), node(0, 0));
    // s = leftMid(src) {100,5}, t = rightMid(tgt) {10,5}
    expect(path.startsWith('M 100 5 C')).toBe(true);
    expect(path.endsWith('10 5')).toBe(true);
  });

  it('connects bottom→top when the source is above the target', () => {
    const path = buildEdgePath(node(0, 0), node(0, 100));
    // s = bottomMid(src) {5,10}, t = topMid(tgt) {5,100}
    expect(path.startsWith('M 5 10 C')).toBe(true);
    expect(path.endsWith('5 100')).toBe(true);
  });

  it('connects top→bottom in the fallback (source below the target)', () => {
    const path = buildEdgePath(node(0, 100), node(0, 0));
    // s = topMid(src) {5,100}, t = bottomMid(tgt) {5,10}
    expect(path.startsWith('M 5 100 C')).toBe(true);
    expect(path.endsWith('5 10')).toBe(true);
  });
});

describe('bezierMidpoint', () => {
  it('evaluates the cubic bezier at t=0.5', () => {
    expect(bezierMidpoint(0, 0, 10, 0, 20, 0, 30, 0)).toEqual({ x: 15, y: 0 });
  });

  it('is symmetric for a symmetric control polygon', () => {
    const mid = bezierMidpoint(0, 0, 0, 10, 10, 10, 10, 0);
    expect(mid).toEqual({ x: 5, y: 7.5 });
  });
});

describe('TYPE_LABELS', () => {
  it('maps relationship types to short labels', () => {
    expect(TYPE_LABELS['many-to-one']).toBe('N:1');
    expect(TYPE_LABELS['one-to-one']).toBe('1:1');
    expect(TYPE_LABELS['many-to-many']).toBe('N:M');
  });
});
