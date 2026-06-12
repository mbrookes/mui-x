'use client';
import * as React from 'react';
import { Box, Popover, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';

export interface NodeLayout {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const TYPE_LABELS: Record<string, string> = {
  'many-to-one': 'N:1',
  'one-to-one': '1:1',
  'many-to-many': 'N:M',
};

function rightMid(n: NodeLayout) {
  return { x: n.x + n.width, y: n.y + n.height / 2 };
}

function leftMid(n: NodeLayout) {
  return { x: n.x, y: n.y + n.height / 2 };
}

function bottomMid(n: NodeLayout) {
  return { x: n.x + n.width / 2, y: n.y + n.height };
}

function topMid(n: NodeLayout) {
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

function bezierMidpoint(
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

export interface EdgeLabelProps {
  rel: StudioRelationship;
  srcNode: NodeLayout;
  tgtNode: NodeLayout;
  sources: Record<string, StudioDataSource>;
  color: string;
  hoverColor: string;
}

export function EdgeLabel({ rel, srcNode, tgtNode, sources, color, hoverColor }: EdgeLabelProps) {
  const [anchorEl, setAnchorEl] = React.useState<SVGElement | null>(null);
  const localeText = useStudioLocaleText();

  const srcIsLeft = srcNode.x + srcNode.width <= tgtNode.x;
  const srcIsRight = srcNode.x >= tgtNode.x + tgtNode.width;
  const srcIsAbove = srcNode.y + srcNode.height <= tgtNode.y;

  let s = rightMid(srcNode);
  let t = leftMid(tgtNode);
  let cp1 = s;
  let cp2 = t;

  if (srcIsLeft) {
    s = rightMid(srcNode);
    t = leftMid(tgtNode);
    const dx = (t.x - s.x) * 0.5;
    cp1 = { x: s.x + dx, y: s.y };
    cp2 = { x: t.x - dx, y: t.y };
  } else if (srcIsRight) {
    s = leftMid(srcNode);
    t = rightMid(tgtNode);
    const dx = (s.x - t.x) * 0.5;
    cp1 = { x: s.x - dx, y: s.y };
    cp2 = { x: t.x + dx, y: t.y };
  } else if (srcIsAbove) {
    s = bottomMid(srcNode);
    t = topMid(tgtNode);
    const dy = (t.y - s.y) * 0.5;
    cp1 = { x: s.x, y: s.y + dy };
    cp2 = { x: t.x, y: t.y - dy };
  } else {
    s = topMid(srcNode);
    t = bottomMid(tgtNode);
    const dy = (s.y - t.y) * 0.5;
    cp1 = { x: s.x, y: s.y - dy };
    cp2 = { x: t.x, y: t.y + dy };
  }

  const mid = bezierMidpoint(s.x, s.y, cp1.x, cp1.y, cp2.x, cp2.y, t.x, t.y);
  const open = Boolean(anchorEl);

  const path = buildEdgePath(srcNode, tgtNode);
  const srcSource = sources[rel.sourceId];
  const tgtSource = sources[rel.targetId];
  const srcFieldLabel =
    srcSource?.fields.find((f) => f.id === rel.sourceField)?.label ?? rel.sourceField;
  const tgtFieldLabel =
    tgtSource?.fields.find((f) => f.id === rel.targetField)?.label ?? rel.targetField;

  return (
    <g>
      {/* Invisible wider hit area */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ cursor: 'default' }}
        onClick={(event) => setAnchorEl(event.currentTarget as SVGElement)}
      />
      {/* Visible edge */}
      <path
        d={path}
        fill="none"
        stroke={open ? hoverColor : color}
        strokeWidth={1.5}
        markerEnd="url(#arrowhead)"
        style={{ pointerEvents: 'none' }}
      />
      {/* Label badge */}
      <g
        style={{ cursor: 'default' }}
        onClick={(event) => setAnchorEl(event.currentTarget as SVGElement)}
      >
        <rect
          x={mid.x - 14}
          y={mid.y - 9}
          width={28}
          height={18}
          rx={4}
          fill={open ? hoverColor : color}
          opacity={0.9}
        />
        <text
          x={mid.x}
          y={mid.y + 4}
          textAnchor="middle"
          fontSize={9}
          fill="white"
          fontFamily="inherit"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {TYPE_LABELS[rel.type] ?? rel.type}
        </text>
      </g>

      {/* Detail popover — rendered outside SVG by MUI */}
      {anchorEl && (
        <foreignObject x={0} y={0} width={1} height={1} overflow="visible">
          <Popover
            open={open}
            anchorEl={anchorEl}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: 'center', horizontal: 'center' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            <Box sx={{ p: 1.5, minWidth: 200 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                {srcSource?.label ?? rel.sourceId} → {tgtSource?.label ?? rel.targetId}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {localeText.lineageTypePrefix(rel.type)}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {localeText.lineageJoinDetail(
                  srcSource?.label ?? rel.sourceId,
                  srcFieldLabel,
                  tgtSource?.label ?? rel.targetId,
                  tgtFieldLabel,
                )}
              </Typography>
              {rel.type === 'many-to-many' && rel.junctionSourceId && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {localeText.lineageViaDetail(
                    sources[rel.junctionSourceId]?.label ?? rel.junctionSourceId,
                  )}
                </Typography>
              )}
            </Box>
          </Popover>
        </foreignObject>
      )}
    </g>
  );
}
