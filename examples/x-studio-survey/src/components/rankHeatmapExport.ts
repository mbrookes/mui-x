import type { RankMatrix } from '../shared/rankMatrix';

export interface RankHeatmapExportConfig {
  showCellNumbers: boolean;
  showMeanColumn: boolean;
  showImportanceLabels: boolean;
  showLegend: boolean;
}

export interface RankHeatmapExportLabels {
  mean: string;
  mostImportant: string;
  leastImportant: string;
}

const BODY_FONT = '11px Arial, Helvetica, sans-serif';
const BOLD_FONT = 'bold 11px Arial, Helvetica, sans-serif';

/** Reads a `--mui-palette-*` CSS variable's live resolved value off `el`, with a fallback. */
function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word-wrap into at most `maxLines` lines, ellipsizing any overflow on the last line. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        let rest = [word, ...words.slice(i + 1)].join(' ');
        while (rest.length > 0 && ctx.measureText(`${rest}…`).width > maxWidth) {
          rest = rest.slice(0, -1);
        }
        lines.push(
          rest.length < [word, ...words.slice(i + 1)].join(' ').length ? `${rest}…` : rest,
        );
        return lines;
      }
    } else {
      current = test;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * Renders the rank heatmap to a PNG and triggers a download. Reimplements the widget's own
 * layout/colour logic directly via the Canvas 2D API — the heatmap is plain HTML/CSS (not SVG
 * like x-charts), so there's no element to serialize the way `exportChartToPng` does; drawing it
 * fresh avoids pulling in a full DOM-rasterization dependency for one widget.
 *
 * Colours are read live from `themeSourceEl`'s computed style (not `theme.palette.*`, which under
 * a cssVariables theme is pinned to the light scheme), so the export always matches whichever
 * light/dark scheme is currently active — exactly like the rendered widget.
 */
export function exportRankHeatmapToPng(
  data: RankMatrix,
  config: RankHeatmapExportConfig,
  labels: RankHeatmapExportLabels,
  fileNameBase: string,
  themeSourceEl: HTMLElement,
): void {
  const { categories, rankCount, matrix, meanRanks, maxCount } = data;
  const style = getComputedStyle(themeSourceEl);
  const primary = readVar(style, '--mui-palette-primary-main', '#1976d2');
  const contrastText = readVar(style, '--mui-palette-primary-contrastText', '#fff');
  const surface = readVar(style, '--mui-palette-background-paper', '#fff');
  const textPrimary = readVar(style, '--mui-palette-text-primary', '#000');
  const textSecondary = readVar(style, '--mui-palette-text-secondary', '#666');

  const cellColor = (count: number): string => {
    const pct = count <= 0 ? 4 : 12 + 88 * (count / maxCount);
    return `color-mix(in srgb, ${primary} ${pct}%, ${surface})`;
  };

  const scale = 2;
  const padding = 16;
  const rowHeight = 36;
  const headerRowHeight = 22;
  const captionRowHeight = 18;
  const legendHeight = 40;
  const meanColWidth = config.showMeanColumn ? 50 : 0;
  const cellColWidth = 40;
  const cellInset = 1.5;
  const lineHeight = 13;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    return;
  }
  measureCtx.font = BODY_FONT;
  // Mirrors the CSS's `minmax(280px, 2.4fr)` label column: wide enough for most labels, clamped
  // since anything longer just wraps to its second line instead of growing the canvas further.
  const widestLabel = categories.reduce(
    (max, c) => Math.max(max, measureCtx.measureText(c).width),
    0,
  );
  const labelColWidth = Math.min(340, Math.max(180, widestLabel + 16));

  const bodyWidth = labelColWidth + meanColWidth + rankCount * cellColWidth;
  const width = padding * 2 + bodyWidth;
  const headerHeight = (config.showImportanceLabels ? captionRowHeight : 0) + headerRowHeight;
  const bodyHeight = categories.length * rowHeight;
  const height = padding * 2 + headerHeight + bodyHeight + (config.showLegend ? legendHeight : 0);

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.scale(scale, scale);

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  let y = padding;

  if (config.showImportanceLabels) {
    ctx.font = BODY_FONT;
    ctx.fillStyle = textSecondary;
    ctx.textBaseline = 'middle';
    const capY = y + captionRowHeight / 2;
    ctx.textAlign = 'left';
    ctx.fillText(labels.mostImportant, padding + labelColWidth + meanColWidth + 2, capY);
    ctx.textAlign = 'right';
    ctx.fillText(labels.leastImportant, padding + bodyWidth - 2, capY);
    y += captionRowHeight;
  }

  {
    const headY = y + headerRowHeight / 2;
    ctx.textBaseline = 'middle';
    if (config.showMeanColumn) {
      ctx.font = BOLD_FONT;
      ctx.fillStyle = textSecondary;
      ctx.textAlign = 'center';
      ctx.fillText(labels.mean, padding + labelColWidth + meanColWidth / 2, headY);
    }
    ctx.font = BOLD_FONT;
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'center';
    for (let r = 0; r < rankCount; r += 1) {
      const cx = padding + labelColWidth + meanColWidth + r * cellColWidth + cellColWidth / 2;
      ctx.fillText(String(r + 1), cx, headY);
    }
    y += headerRowHeight;
  }

  categories.forEach((category, catIndex) => {
    const rowTop = y + catIndex * rowHeight;
    const rowMidY = rowTop + rowHeight / 2;

    ctx.font = BODY_FONT;
    ctx.fillStyle = textPrimary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelLines = wrapText(measureCtx, category, labelColWidth - 12, 2);
    const labelStartY = rowMidY - ((labelLines.length - 1) * lineHeight) / 2;
    labelLines.forEach((line, i) => {
      ctx.fillText(line, padding + labelColWidth - 6, labelStartY + i * lineHeight);
    });

    if (config.showMeanColumn) {
      ctx.font = BOLD_FONT;
      ctx.fillStyle = textSecondary;
      ctx.textAlign = 'center';
      ctx.fillText(
        meanRanks[catIndex].toFixed(1),
        padding + labelColWidth + meanColWidth / 2,
        rowMidY,
      );
    }

    matrix[catIndex].forEach((count, rankIndex) => {
      const cellX = padding + labelColWidth + meanColWidth + rankIndex * cellColWidth;
      ctx.fillStyle = cellColor(count);
      drawRoundedRect(
        ctx,
        cellX + cellInset,
        rowTop + cellInset,
        cellColWidth - cellInset * 2,
        rowHeight - cellInset * 2,
        2,
      );
      ctx.fill();

      if (config.showCellNumbers && count > 0) {
        ctx.font = BODY_FONT;
        ctx.fillStyle = count / maxCount > 0.55 ? contrastText : textSecondary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(count), cellX + cellColWidth / 2, rowMidY);
      }
    });
  });

  if (config.showLegend) {
    const legendY = y + bodyHeight + legendHeight / 2;
    const legendBarWidth = 120;
    const legendBarHeight = 8;
    const legendBarX = padding + bodyWidth - legendBarWidth - 24;
    const gradient = ctx.createLinearGradient(legendBarX, 0, legendBarX + legendBarWidth, 0);
    gradient.addColorStop(0, `color-mix(in srgb, ${primary} 12%, ${surface})`);
    gradient.addColorStop(1, primary);

    ctx.font = BODY_FONT;
    ctx.fillStyle = textSecondary;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('0', legendBarX - 8, legendY);
    ctx.fillStyle = gradient;
    drawRoundedRect(
      ctx,
      legendBarX,
      legendY - legendBarHeight / 2,
      legendBarWidth,
      legendBarHeight,
      4,
    );
    ctx.fill();
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(String(maxCount), legendBarX + legendBarWidth + 8, legendY);
  }

  canvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileNameBase.replace(/[^a-z0-9]/gi, '_')}_heatmap.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 'image/png');
}
