'use client';
import * as React from 'react';
import { Box, Popover, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';
import {
  type NodeLayout,
  buildEdgePath,
  bezierMidpoint,
  rightMid,
  leftMid,
  bottomMid,
  topMid,
  TYPE_LABELS,
} from './edgeGeometry';

interface EdgeLabelProps {
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

  const edgeAriaLabel = `${srcSource?.label ?? rel.sourceId} to ${
    tgtSource?.label ?? rel.targetId
  }, ${rel.type}`;

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
      {/* Label badge — focusable button so the relationship details are reachable by keyboard */}
      <g
        role="button"
        tabIndex={0}
        aria-label={edgeAriaLabel}
        aria-haspopup="dialog"
        style={{ cursor: 'pointer' }}
        onClick={(event) => setAnchorEl(event.currentTarget as SVGElement)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setAnchorEl(event.currentTarget as unknown as SVGElement);
          }
        }}
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
