'use client';
import * as React from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { EdgeLabel } from './EdgeLabel';
import type { NodeLayout } from './edgeGeometry';

const NODE_W = 120;
const NODE_H = 40;
const H_GAP = 60;
const V_GAP = 50;
const PADDING = 20;
const COLS = 3;

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

interface DataLineageGraphProps {
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
  const localeText = useStudioLocaleText();
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

  // Accessible name for the diagram. `role="group"` (not `img`) keeps the
  // interactive nodes/edges reachable while still naming the graph as a whole.
  const graphAriaLabel = `Data relationship graph with ${sourceList.length} ${
    sourceList.length === 1 ? 'source' : 'sources'
  } and ${visibleRels.length} ${visibleRels.length === 1 ? 'relationship' : 'relationships'}.`;

  return (
    <Box sx={{ width: '100%', overflowX: 'auto' }}>
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        role="group"
        aria-label={graphAriaLabel}
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
            role={onNodeClick ? 'button' : 'img'}
            tabIndex={onNodeClick ? 0 : undefined}
            aria-label={onNodeClick ? localeText.lineagePreviewAriaLabel(node.label) : node.label}
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
          {localeText.lineageNoRelationships}
        </Typography>
      )}
    </Box>
  );
}
