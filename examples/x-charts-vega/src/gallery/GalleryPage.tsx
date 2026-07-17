import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { VegaLiteChart } from '@mui/x-charts-vega';
import type { TranslationGap } from '@mui/x-charts-vega';
import { inlineData } from './resolveData';
import VegaEmbed from './VegaEmbed';
import { examples, exampleIds, type GalleryExample } from './examples';
import { useScrollSpyHash } from './useScrollSpyHash';
import { ChartErrorBoundary } from './ChartErrorBoundary';

// The continuous-axis view size handed to the reference `vega-embed` view. It
// matches the wrapper's own default (`VEGA_DEFAULT_VIEW_WIDTH`/`_HEIGHT`), so a
// chart whose spec gives no size renders at the same size on both sides; charts
// that declare a size (or a discrete `{step}`) size themselves identically on
// both sides regardless.
const CHART_WIDTH = 440;
const CHART_HEIGHT = 340;

const SEVERITY_COLOR: Record<TranslationGap['severity'], 'error' | 'warning' | 'default'> = {
  unsupported: 'error',
  partial: 'warning',
  ignored: 'default',
};

// The gap's origin: a genuine Vega-Lite coverage gap vs. an x-charts limitation
// the wrapper approximates or works around.
const ORIGIN_LABEL: Record<'vega-lite' | 'x-charts', string> = {
  'vega-lite': 'vega-lite',
  'x-charts': 'x-charts',
};

/** A titled, bordered panel holding one chart of a side-by-side comparison. */
function ComparisonPanel({
  label,
  labelColor,
  children,
}: {
  label: string;
  labelColor: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Typography
        variant="overline"
        sx={{
          px: 1,
          py: 0.25,
          color: labelColor,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'action.hover',
          fontWeight: 600,
          lineHeight: 2,
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          flexGrow: 1,
          display: 'flex',
          // Plain `center` makes the *leading* (left) overflow unreachable by
          // scrolling in Chromium once the child is wider than this box — only
          // the trailing side scrolls, so a wide spec's y-axis labels render
          // past the left edge with no way to scroll to them. `safe center`
          // still centers a chart that fits, but falls back to start-alignment
          // (fully scrollable both ways) the moment it doesn't.
          justifyContent: 'safe center',
          alignItems: 'safe center',
          p: 1,
          minHeight: CHART_HEIGHT + 20,
          overflowX: 'auto',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

function GalleryCard({ example }: { example: GalleryExample }) {
  const [gaps, setGaps] = React.useState<TranslationGap[]>([]);
  // Inline the referenced datasets once; the wrapper then renders the spec as-is.
  const resolvedSpec = React.useMemo(() => inlineData(example.spec), [example.spec]);
  const specJson = React.useMemo(() => JSON.stringify(example.spec, null, 2), [example.spec]);

  return (
    // `overflow: 'visible'` overrides Card's default `overflow: 'hidden'`
    // (there for rounded-corner clipping) — at very narrow viewports a
    // legend-heavy comparison can still be a few px wider than the card even
    // after the grid/legend sizing above, and ComparisonPanel's own
    // `overflowX: 'auto'` inner box (see below) should be the one deciding
    // what happens to any residual overflow (a scrollbar), not the card
    // silently discarding it.
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column', overflow: 'visible' }}>
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flexGrow: 1 }}>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" id={example.name} sx={{ scrollMarginTop: 16 }}>
              {example.title}
            </Typography>
            {example.category && <Chip size="small" variant="outlined" label={example.category} />}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            vega-lite example{' '}
            <Link
              href={`https://vega.github.io/vega-lite/examples/${example.name}.html`}
              target="_blank"
              rel="noreferrer"
            >
              {example.name}
            </Link>
          </Typography>
        </Box>

        <Box
          sx={{
            display: 'grid',
            // A fixed `1fr 1fr` split squeezes both panels to ~half the card
            // width regardless of content — fine for a plain 440px chart, but
            // a chart with a wide side legend (many categories) then has no
            // room for its legend column and silently scrolls/clips it.
            // `auto-fit, minmax(...)` keeps the usual two-up layout when both
            // panels fit, and stacks to one column (giving each panel the
            // full card width) when they don't, instead of forcing a squeeze.
            // The `min(400px, 100%)` floor matters on a narrower-than-400px
            // viewport (mobile): plain `minmax(400px, 1fr)` still enforces
            // the 400px minimum even then, so the single column overflows
            // its own card — which clips it via the card's `overflow:
            // hidden` — instead of shrinking to fit.
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(400px, 100%), 1fr))',
            gap: 1.5,
          }}
        >
          <ComparisonPanel label="@mui/x-charts-vega" labelColor="primary.main">
            {/* No explicit size: the wrapper sizes each view the way Vega-Lite
                does (spec size / step-based / default), matching the reference. */}
            <ChartErrorBoundary>
              <VegaLiteChart spec={resolvedSpec} onGaps={setGaps} />
            </ChartErrorBoundary>
          </ComparisonPanel>
          <ComparisonPanel label="Vega-Lite reference" labelColor="success.main">
            {/* The same continuous default the wrapper uses, so a chart with no
                spec size renders at the same size on both sides. */}
            <ChartErrorBoundary>
              <VegaEmbed spec={resolvedSpec} width={CHART_WIDTH} height={CHART_HEIGHT} />
            </ChartErrorBoundary>
          </ComparisonPanel>
        </Box>

        <Box>
          {(() => {
            const originOf = (gap: TranslationGap) => gap.origin ?? 'vega-lite';
            const vegaLiteCount = gaps.filter((gap) => originOf(gap) === 'vega-lite').length;
            const xChartsCount = gaps.length - vegaLiteCount;
            return (
              <React.Fragment>
                <Typography variant="subtitle2" gutterBottom>
                  Gaps reported via onGaps ({gaps.length})
                </Typography>
                {gaps.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No untranslatable features — the spec rendered natively.
                  </Typography>
                ) : (
                  <React.Fragment>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mb: 0.5 }}
                    >
                      {vegaLiteCount} Vega-Lite feature{vegaLiteCount === 1 ? '' : 's'} not
                      supported · {xChartsCount} x-charts limitation{xChartsCount === 1 ? '' : 's'}{' '}
                      worked around
                    </Typography>
                    <Stack spacing={0.5}>
                      {gaps.map((gap) => {
                        const origin = originOf(gap);
                        return (
                          <Box key={`${gap.code}|${gap.path ?? ''}`}>
                            <Stack
                              direction="row"
                              spacing={1}
                              sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                            >
                              <Chip
                                size="small"
                                variant="outlined"
                                color={origin === 'x-charts' ? 'info' : 'default'}
                                label={ORIGIN_LABEL[origin]}
                              />
                              <Chip
                                size="small"
                                color={SEVERITY_COLOR[gap.severity]}
                                label={gap.severity}
                              />
                              <Typography
                                variant="body2"
                                component="code"
                                sx={{ fontFamily: 'monospace' }}
                              >
                                {gap.code}
                              </Typography>
                            </Stack>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block', ml: 0.5, mb: 0.5 }}
                            >
                              {gap.message}
                            </Typography>
                          </Box>
                        );
                      })}
                    </Stack>
                  </React.Fragment>
                )}
              </React.Fragment>
            );
          })()}
        </Box>

        <Box component="details">
          <Box component="summary" sx={{ cursor: 'pointer' }}>
            <Typography variant="caption" component="span">
              Vega-Lite spec (JSON)
            </Typography>
          </Box>
          <Box
            component="pre"
            sx={{
              fontSize: 12,
              overflowX: 'auto',
              maxHeight: 320,
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1,
              m: 0,
              mt: 1,
            }}
          >
            {specJson}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

export default function GalleryPage() {
  useScrollSpyHash(exampleIds);
  return (
    <React.Fragment>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 820 }}>
        The {examples.length} official{' '}
        <Link href="https://vega.github.io/vega-lite/examples/" target="_blank" rel="noreferrer">
          Vega-Lite example gallery
        </Link>{' '}
        specs below are run verbatim through <code>&lt;VegaLiteChart /&gt;</code> (left) and, for
        comparison, the reference <code>vega-lite</code> runtime via <code>vega-embed</code>{' '}
        (right). Both sides receive the same spec with its <code>vega-datasets</code> already
        inlined, so any difference is a translation difference, not a data one. To read like the
        reference, the wrapper reproduces Vega-Lite&apos;s defaults — the <code>tableau10</code>{' '}
        palette and exact named color schemes, ordered sequential ramps for schemes like{' '}
        <code>magma</code>, ascending legend order, descending-by-value stack geometry, gridlines on
        continuous axes, the plot-area view border, <code>timeUnit</code> month/quarter labels,
        Vega-style typography, and label-fitting axes. Everything it still cannot translate — and
        every x-charts limitation it works around — is reported live via <code>onGaps</code> below
        each comparison, tagged by origin.
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: 3,
        }}
      >
        {examples.map((example) => (
          <GalleryCard key={example.name} example={example} />
        ))}
      </Box>
    </React.Fragment>
  );
}
