'use client';
import {
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { ChartsLabelMark } from '@mui/x-charts/internals';

export function ChoroplethTooltipContent() {
  const tooltipData = useItemTooltip<'choropleth'>();

  if (!tooltipData) {
    return null;
  }

  const { color, label, formattedValue, markType } = tooltipData;

  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        <tbody>
          <ChartsTooltipRow>
            <ChartsTooltipCell component="th">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChartsLabelMark type={markType} color={color} />
                {label}
              </div>
            </ChartsTooltipCell>
            <ChartsTooltipCell component="td">{formattedValue}</ChartsTooltipCell>
          </ChartsTooltipRow>
        </tbody>
      </ChartsTooltipTable>
    </ChartsTooltipPaper>
  );
}
