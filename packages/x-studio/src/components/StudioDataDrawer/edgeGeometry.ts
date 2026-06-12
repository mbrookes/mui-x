export interface NodeLayout {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TYPE_LABELS: Record<string, string> = {
  'many-to-one': 'N:1',
  'one-to-one': '1:1',
  'many-to-many': 'N:M',
};

export function rightMid(n: NodeLayout) {
  return { x: n.x + n.width, y: n.y + n.height / 2 };
}

export function leftMid(n: NodeLayout) {
  return { x: n.x, y: n.y + n.height / 2 };
}

export function bottomMid(n: NodeLayout) {
  return { x: n.x + n.width / 2, y: n.y + n.height };
}

export function topMid(n: NodeLayout) {
  return { x: n.x + n.width / 2, y: n.y };
}

export function buildEdgePath(src: NodeLayout, tgt: NodeLayout): string {
  const srcIsLeft = src.x + src.width <= tgt.x;
  const srcIsRight = src.x >= tgt.x + tgt.width;
  const srcIsAbove = src.y + src.height <= tgt.y;

  let s: { x: number; y: number };
  let t: { x: number; y: number };
  let cp1: { x: number; y: number };
  let cp2: { x: number; y: number };

  if (srcIsLeft) {
    s = rightMid(src);
    t = leftMid(tgt);
    const dx = (t.x - s.x) * 0.5;
    cp1 = { x: s.x + dx, y: s.y };
    cp2 = { x: t.x - dx, y: t.y };
  } else if (srcIsRight) {
    s = leftMid(src);
    t = rightMid(tgt);
    const dx = (s.x - t.x) * 0.5;
    cp1 = { x: s.x - dx, y: s.y };
    cp2 = { x: t.x + dx, y: t.y };
  } else if (srcIsAbove) {
    s = bottomMid(src);
    t = topMid(tgt);
    const dy = (t.y - s.y) * 0.5;
    cp1 = { x: s.x, y: s.y + dy };
    cp2 = { x: t.x, y: t.y - dy };
  } else {
    s = topMid(src);
    t = bottomMid(tgt);
    const dy = (s.y - t.y) * 0.5;
    cp1 = { x: s.x, y: s.y - dy };
    cp2 = { x: t.x, y: t.y + dy };
  }

  return `M ${s.x} ${s.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${t.x} ${t.y}`;
}

export function bezierMidpoint(
  sx: number,
  sy: number,
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  ex: number,
  ey: number,
): { x: number; y: number } {
  const t = 0.5;
  const mt = 1 - t;
  const x = mt * mt * mt * sx + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * ex;
  const y = mt * mt * mt * sy + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * ey;
  return { x, y };
}
