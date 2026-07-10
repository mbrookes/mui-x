'use client';
import * as React from 'react';
import Typography from '@mui/material/Typography';
import {
  ChartsTooltipCell,
  ChartsTooltipContainer,
  ChartsTooltipPaper,
  ChartsTooltipRow,
  ChartsTooltipTable,
  useAxesTooltip,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { isFieldDef } from '../types';
import type { VegaChannelDef } from '../types';

/** A single field the Vega-Lite `tooltip` channel asked to surface. */
export interface VegaTooltipField {
  /** The dataset field name. */
  field: string;
  /** Display label (`title` override, falling back to the field name). */
  label: string;
}

/**
 * Flattens a Vega-Lite `tooltip` encoding (a single field def or an array of
 * them) into the ordered list of field labels the author wants shown. Value /
 * datum defs carry no field to surface and are skipped.
 */
export function resolveTooltipFields(
  tooltip: VegaChannelDef | VegaChannelDef[] | null | undefined,
): VegaTooltipField[] {
  if (tooltip == null) {
    return [];
  }
  const defs = Array.isArray(tooltip) ? tooltip : [tooltip];
  const fields: VegaTooltipField[] = [];
  for (const def of defs) {
    if (isFieldDef(def) && typeof def.field === 'string') {
      fields.push({
        field: def.field,
        label: typeof def.title === 'string' ? def.title : def.field,
      });
    }
  }
  return fields;
}

const swatchStyle: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 2,
  display: 'inline-block',
  flexShrink: 0,
  marginRight: 8,
  verticalAlign: 'middle',
};

/**
 * Caption listing the fields the `tooltip` channel declared, so the rendered
 * tooltip visibly reflects the spec even though per-field values for
 * non-encoded columns can't be resolved from the compiled series alone.
 */
function TooltipFieldCaption(props: { fields: VegaTooltipField[] }) {
  if (props.fields.length === 0) {
    return null;
  }
  return (
    <Typography component="caption" variant="caption" sx={{ display: 'block' }}>
      {props.fields.map((entry) => entry.label).join(' · ')}
    </Typography>
  );
}

/** Axis-triggered content: the highlighted axis value plus its series items. */
function VegaAxisTooltipContent(props: { fields: VegaTooltipField[] }) {
  const tooltipData = useAxesTooltip();
  if (tooltipData == null || tooltipData.length === 0) {
    return null;
  }
  return (
    <ChartsTooltipPaper>
      {tooltipData.map((axisData) => (
        <ChartsTooltipTable key={axisData.axisId}>
          <TooltipFieldCaption fields={props.fields} />
          {axisData.axisValue != null && !axisData.mainAxis.hideTooltip && (
            <Typography component="caption">{axisData.axisFormattedValue}</Typography>
          )}
          <tbody>
            {axisData.seriesItems.map((item) => (
              <ChartsTooltipRow key={item.seriesId} data-series={item.seriesId}>
                <ChartsTooltipCell component="th">
                  <span aria-hidden style={{ ...swatchStyle, backgroundColor: item.color }} />
                  {item.formattedLabel}
                </ChartsTooltipCell>
                <ChartsTooltipCell component="td">{item.formattedValue}</ChartsTooltipCell>
              </ChartsTooltipRow>
            ))}
          </tbody>
        </ChartsTooltipTable>
      ))}
    </ChartsTooltipPaper>
  );
}

/** Item-triggered content (heatmap cells, pie slices): the single hovered item. */
function VegaItemTooltipContent(props: { fields: VegaTooltipField[] }) {
  const tooltipData = useItemTooltip();
  if (tooltipData == null) {
    return null;
  }
  const { color, label, formattedValue } = tooltipData;
  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        <TooltipFieldCaption fields={props.fields} />
        <tbody>
          <ChartsTooltipRow data-series={tooltipData.identifier.seriesId}>
            <ChartsTooltipCell component="th">
              <span aria-hidden style={{ ...swatchStyle, backgroundColor: color }} />
              {label}
            </ChartsTooltipCell>
            <ChartsTooltipCell component="td">
              {typeof formattedValue === 'string' ? formattedValue : null}
            </ChartsTooltipCell>
          </ChartsTooltipRow>
        </tbody>
      </ChartsTooltipTable>
    </ChartsTooltipPaper>
  );
}

export interface VegaTooltipProps {
  /** Fields the Vega-Lite `tooltip` channel asked to surface. */
  fields: VegaTooltipField[];
  /**
   * Tooltip trigger, mirroring `<ChartsTooltip>`: `'item'` for marks without an
   * axis-tooltip payload (heatmap/pie), otherwise the default axis trigger.
   */
  trigger?: 'item' | 'axis';
}

/**
 * A custom tooltip for cartesian/polar Vega-Lite views that declare a
 * `tooltip` encoding. It reuses x-charts' tooltip hooks to render the
 * highlighted series values and prefixes them with the spec's declared field
 * list.
 *
 * Best-effort limitation: the compiled dataset rows are not exposed to the
 * shell, so tooltip fields that are not part of the x/y/color encoding are
 * shown as labels only (their per-point values can't be resolved here). Fully
 * faithful per-field values would need the compiler to thread raw rows through
 * `CompiledChart`.
 */
export function VegaTooltip(props: VegaTooltipProps) {
  const { fields, trigger } = props;
  return (
    <ChartsTooltipContainer trigger={trigger}>
      {trigger === 'item' ? (
        <VegaItemTooltipContent fields={fields} />
      ) : (
        <VegaAxisTooltipContent fields={fields} />
      )}
    </ChartsTooltipContainer>
  );
}
