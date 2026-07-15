import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { VegaLiteChart } from '@mui/x-charts-vega';
import type { TranslationGap, VegaLiteSpec } from '@mui/x-charts-vega';
import { inlineData } from './resolveData';
import VegaEmbed from './VegaEmbed';
import titles from './titles.json';

// Chart panel size shared by both sides of every comparison. Slightly taller
// than wide, closer to Vega-Lite's own default proportions than a wide
// dashboard tile, without going as narrow as Vega's square default.
const CHART_WIDTH = 440;
const CHART_HEIGHT = 340;

// The verbatim Vega-Lite example specs, fetched from vega/vega-lite (see
// resolveData.ts). Keyed by base filename.
const specModules = import.meta.glob('./specs/*.json', { eager: true, import: 'default' });
const titleMap = titles as Record<string, { title: string; category: string }>;

interface GalleryExample {
  name: string;
  title: string;
  category: string;
  spec: VegaLiteSpec;
}

const examples: GalleryExample[] = Object.entries(specModules)
  .map(([path, spec]) => {
    const name = path.replace(/^.*\/([^/]+)\.json$/, '$1');
    return {
      name,
      title: titleMap[name]?.title ?? name,
      category: titleMap[name]?.category ?? '',
      spec: spec as VegaLiteSpec,
    };
  })
  .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));

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
          justifyContent: 'center',
          alignItems: 'center',
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
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flexGrow: 1 }}>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2">
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
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            gap: 1.5,
          }}
        >
          <ComparisonPanel label="@mui/x-charts-vega" labelColor="primary.main">
            <VegaLiteChart
              spec={resolvedSpec}
              width={CHART_WIDTH}
              height={CHART_HEIGHT}
              onGaps={setGaps}
            />
          </ComparisonPanel>
          <ComparisonPanel label="Vega-Lite reference" labelColor="success.main">
            <VegaEmbed spec={resolvedSpec} width={CHART_WIDTH} height={CHART_HEIGHT} />
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
        palette and exact named color schemes, ascending legend order, descending-by-value stack
        geometry, gridlines on continuous axes, <code>timeUnit</code> month/quarter labels, and
        label-fitting axes. Everything it still cannot translate is reported live via{' '}
        <code>onGaps</code> below each comparison.
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
