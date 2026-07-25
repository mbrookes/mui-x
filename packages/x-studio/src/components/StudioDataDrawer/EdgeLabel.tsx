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

/**
 * Locale-text key holding the human-readable name of each relationship type. The visible
 * badge deliberately keeps the compact, language-neutral `TYPE_LABELS` glyphs (`N:1`, `1:1`,
 * `N:M`), but the accessible name and the detail popover need real words — and translated
 * ones. Reuses the keys the relationship panel/dialog already ship in every locale.
 */
const REL_TYPE_LOCALE_KEYS = {
  'many-to-one': 'relationshipTypeManyToOne',
  'one-to-one': 'relationshipTypeOneToOne',
  'many-to-many': 'relationshipTypeManyToMany',
} as const;

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
  // `rel.sourceId`/`rel.targetId` are doc-authored (host/AI-writable): guard the record index
  // against inherited keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a
  // function off `Object.prototype` instead of `undefined` (prototype-chain key lookup fix).
  const srcSource = Object.hasOwn(sources, rel.sourceId) ? sources[rel.sourceId] : undefined;
  const tgtSource = Object.hasOwn(sources, rel.targetId) ? sources[rel.targetId] : undefined;
  const srcFieldLabel =
    srcSource?.fields?.find((f) => f.id === rel.sourceField)?.label ?? rel.sourceField;
  const tgtFieldLabel =
    tgtSource?.fields?.find((f) => f.id === rel.targetField)?.label ?? rel.targetField;

  const srcLabel = srcSource?.label ?? rel.sourceId;
  const tgtLabel = tgtSource?.label ?? rel.targetId;
  // `rel.type` is doc-authored: guard the lookup against inherited `Object.prototype` keys,
  // and fall back to the raw value for a type the UI doesn't know about.
  const relTypeLabel = Object.hasOwn(REL_TYPE_LOCALE_KEYS, rel.type)
    ? localeText[REL_TYPE_LOCALE_KEYS[rel.type as keyof typeof REL_TYPE_LOCALE_KEYS]]
    : rel.type;
  // Built entirely from locale text: the connector used to be a hardcoded English " to " and
  // the type a raw enum value (`many-to-one`), so a screen reader in any non-English locale
  // announced this control half-untranslated. The arrow is language-neutral and matches the
  // heading the popover below already renders.
  const edgeAriaLabel = `${srcLabel} → ${tgtLabel}, ${localeText.lineageTypePrefix(relTypeLabel)}`;

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
          {/* `rel.type` is doc-authored: guard against inherited `Object.prototype` keys
          (e.g. "constructor") so we never render a function as an SVG text child. */}
          {Object.hasOwn(TYPE_LABELS, rel.type) ? TYPE_LABELS[rel.type] : rel.type}
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
                {srcLabel} → {tgtLabel}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {localeText.lineageTypePrefix(relTypeLabel)}
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
                    (Object.hasOwn(sources, rel.junctionSourceId)
                      ? sources[rel.junctionSourceId]
                      : undefined
                    )?.label ?? rel.junctionSourceId,
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
