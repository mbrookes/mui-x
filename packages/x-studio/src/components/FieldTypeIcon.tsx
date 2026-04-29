'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import type { StudioDataField } from '../models';

export type FieldType = StudioDataField['type'];

// ─── Custom SVG field-type icons ────────────────────────────────────────────

/** "T" — text / string */
function StringTypeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <line x1="3" y1="3.5" x2="13" y2="3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="8" y1="3.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** "#" — numeric */
function NumberTypeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      {/* slightly slanted verticals for classic # look */}
      <line x1="5.5" y1="2.5" x2="4.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="10" x2="13.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Calendar — date */
function DateTypeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="4.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" />
      <line x1="5" y1="2.5" x2="5" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="2.5" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* three date dots */}
      <circle cx="5.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="8.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="11.5" cy="10.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Clock face — datetime */
function DateTimeTypeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      {/* hour hand pointing ~10 o'clock */}
      <line x1="8" y1="8" x2="5.5" y2="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* minute hand pointing to 3 */}
      <line x1="8" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Toggle switch — boolean */
function BooleanTypeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="5" width="13" height="6" rx="3" stroke="currentColor" strokeWidth="1.3" />
      {/* knob in "on" position */}
      <circle cx="10.5" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

// ─── Mapping tables ──────────────────────────────────────────────────────────

const TYPE_SVG: Record<FieldType, React.ComponentType<{ size: number }>> = {
  string: StringTypeIcon,
  number: NumberTypeIcon,
  date: DateTypeIcon,
  datetime: DateTimeTypeIcon,
  boolean: BooleanTypeIcon,
};

const TYPE_LABEL: Record<FieldType, string> = {
  string: 'Text',
  number: 'Number',
  date: 'Date',
  datetime: 'Date & Time',
  boolean: 'Boolean',
};

// ─── Public component ────────────────────────────────────────────────────────

interface FieldTypeIconProps {
  type: FieldType;
  generated?: boolean;
  size?: number;
}

export function FieldTypeIcon({ type, generated = false, size = 16 }: FieldTypeIconProps) {
  const SvgIcon = TYPE_SVG[type] ?? StringTypeIcon;
  const label = `${TYPE_LABEL[type] ?? type}${generated ? ' (generated)' : ''}`;

  return (
    <Tooltip title={label} placement="top">
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '1px',
          flexShrink: 0,
          color: 'text.disabled',
        }}
      >
        {generated && (
          <Box
            component="span"
            sx={{
              fontSize: size * 0.7,
              fontWeight: 700,
              lineHeight: 1,
              fontFamily: 'monospace',
            }}
          >
            =
          </Box>
        )}
        <SvgIcon size={size} />
      </Box>
    </Tooltip>
  );
}
