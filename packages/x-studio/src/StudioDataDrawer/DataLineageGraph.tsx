'use client';
import * as React from 'react';
import { Box, Popover, Typography, useTheme } from '@mui/material';
import type { StudioDataSource, StudioRelationship } from '../models';

interface NodeLayout {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_W = 120;
const NODE_H = 40;
const H_GAP = 60; // horizontal gap between nodes
const V_GAP = 50; // vertical gap between rows
const PADDING = 20;
const COLS = 3; // max nodes per row

/** Compute a simple grid layout for source nodes. */
function layoutNodes(sources: StudioDataSource[]): NodeLayout[] {
  return sources.map((src, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      id: src.id,
      label: src.label,
      x: PADDING + col * (NODE_W + H_GAP),
      y: PADDING + row * (NODE_H + V_GAP),
      width: NODE_W,
      height: NODE_H,
    };
  });
}

/** Returns the midpoint of the right edge of a node. */
function rightMid(n: NodeLayout) {
  return { x: n.x + n.width, y: n.y + n.height / 2 };
}

/** Returns the midpoint of the left edge of a node. */
function leftMid(n: NodeLayout) {
  return { x: n.x, y: n.y + n.height / 2 };
}

/** Returns the midpoint of the bottom edge of a node. */
function bottomMid(n: NodeLayout) {
  return { x: n.x + n.width / 2, y: n.y + n.height };
}

/** Returns the midpoint of the top edge of a node. */
function topMid(n: NodeLayout) {
  return { x: n.x + n.width / 2, y: n.y };
}

/** Build an SVG cubic bezier path between two node layouts. */
function buildEdgePath(src: NodeLayout, tgt: NodeLayout): string {
  // Choose exit/entry based on relative position
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

/** Returns the midpoint along a cubic bezier curve (t=0.5). */
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

const TYPE_LABELS: Record<string, string> = {
  'many-to-one': 'N:1',
  'one-to-one': '1:1',
  'many-to-many': 'N:M',
};

interface EdgeLabelProps {
  rel: StudioRelationship;
  srcNode: NodeLayout;
  tgtNode: NodeLayout;
  sources: Record<string, StudioDataSource>;
  color: string;
  hoverColor: string;
}

function EdgeLabel({ rel, srcNode, tgtNode, sources, color, hoverColor }: EdgeLabelProps) {
  const [anchorEl, setAnchorEl] = React.useState<SVGElement | null>(null);

  // Compute label position (midpoint of bezier)
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
        style={{ cursor: 'pointer' }}
        onClick={(e) => setAnchorEl(e.currentTarget as SVGElement)}
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
      <g style={{ cursor: 'pointer' }} onClick={(e) => setAnchorEl(e.currentTarget as SVGElement)}>
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
                Type: {rel.type}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Join: {srcSource?.label}.{srcFieldLabel} = {tgtSource?.label}.{tgtFieldLabel}
              </Typography>
              {rel.type === 'many-to-many' && rel.junctionSourceId && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Via: {sources[rel.junctionSourceId]?.label ?? rel.junctionSourceId}
                </Typography>
              )}
            </Box>
          </Popover>
        </foreignObject>
      )}
    </g>
  );
}

export interface DataLineageGraphProps {
  sources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  onNodeClick?: (sourceId: string) => void;
}

/**
 * SVG-based data lineage graph.
 * Source nodes are laid out in a grid; relationship edges are cubic bezier curves.
 * Click an edge label to see join key details.
 */
export function DataLineageGraph({ sources, relationships, onNodeClick }: DataLineageGraphProps) {
  const theme = useTheme();
  const nodeColor = theme.palette.primary.main;
  const edgeColor = theme.palette.text.secondary;
  const edgeHoverColor = theme.palette.primary.main;

  const sourceList = React.useMemo(
    () => Object.values(sources).filter((s) => !s.hidden),
    [sources],
  );

  const nodes = React.useMemo(() => layoutNodes(sourceList), [sourceList]);
  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const cols = Math.min(sourceList.length, COLS);
  const rows = Math.ceil(sourceList.length / COLS);
  const svgWidth = PADDING * 2 + cols * NODE_W + (cols - 1) * H_GAP;
  const svgHeight = PADDING * 2 + rows * NODE_H + (rows - 1) * V_GAP;

  if (sourceList.length === 0) {
    return null;
  }

  // Filter to relationships between known sources
  const visibleRels = relationships.filter(
    (r) => nodeById.has(r.sourceId) && nodeById.has(r.targetId),
  );

  return (
    <Box sx={{ width: '100%', overflowX: 'auto' }}>
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ display: 'block' }}
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill={edgeColor} opacity={0.7} />
          </marker>
        </defs>

        {/* Edges (drawn below nodes) */}
        {visibleRels.map((rel) => {
          const srcNode = nodeById.get(rel.sourceId);
          const tgtNode = nodeById.get(rel.targetId);
          if (!srcNode || !tgtNode) {
            return null;
          }
          return (
            <EdgeLabel
              key={rel.id}
              rel={rel}
              srcNode={srcNode}
              tgtNode={tgtNode}
              sources={sources}
              color={edgeColor}
              hoverColor={edgeHoverColor}
            />
          );
        })}

        {/* Source nodes */}
        {nodes.map((node) => (
          <g
            key={node.id}
            onClick={onNodeClick ? () => onNodeClick(node.id) : undefined}
            onKeyDown={
              onNodeClick
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onNodeClick(node.id);
                    }
                  }
                : undefined
            }
            role={onNodeClick ? 'button' : undefined}
            tabIndex={onNodeClick ? 0 : undefined}
            aria-label={onNodeClick ? `Preview ${node.label}` : undefined}
            style={onNodeClick ? { cursor: 'pointer' } : undefined}
          >
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={6}
              fill={theme.palette.background.paper}
              stroke={nodeColor}
              strokeWidth={1.5}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + node.height / 2 + 4}
              textAnchor="middle"
              fontSize={11}
              fill={nodeColor}
              fontFamily="inherit"
              fontWeight={600}
              style={{ userSelect: 'none' }}
            >
              {node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
      {visibleRels.length === 0 && sourceList.length >= 2 && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.5, textAlign: 'center' }}
        >
          No relationships defined between sources
        </Typography>
      )}
    </Box>
  );
}
