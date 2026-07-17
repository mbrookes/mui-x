import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { VegaLiteChart } from '@mui/x-charts-vega';
import { inlineData } from './resolveData';
import { examples, exampleIds, type GalleryExample } from './examples';
import { useScrollSpyHash } from './useScrollSpyHash';
import { ChartErrorBoundary } from './ChartErrorBoundary';

/**
 * One example, sized to nothing but its own chart: no forced `width`/`height`
 * prop reaches `<VegaLiteChart />`, so it renders at Vega-Lite's own natural
 * size for the spec (an explicit spec size, step-based band sizing, or the
 * continuous default) — the same sizing this wrapper works hard to match, just
 * without a reference panel dictating a shared column width around it. The
 * card itself is `width: 'fit-content'` so it hugs that natural size instead of
 * stretching to fill its flex-wrap track, and the whole page's flex-wrap
 * layout (see `FullGalleryPage`) then tiles cards left-to-right using
 * whatever width they actually need.
 */
function NativeSizeCard({ example }: { example: GalleryExample }) {
  const resolvedSpec = React.useMemo(() => inlineData(example.spec), [example.spec]);

  return (
    <Card
      variant="outlined"
      sx={{
        display: 'inline-flex',
        flexDirection: 'column',
        width: 'fit-content',
        maxWidth: '100%',
      }}
    >
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography
              variant="subtitle1"
              component="h2"
              id={example.name}
              sx={{ scrollMarginTop: 16 }}
            >
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
        {/* No onGaps here — this page is purely about rendering every example
            at its natural size; the side-by-side gallery already covers the
            gap report and reference comparison per spec. */}
        <Box sx={{ overflowX: 'auto' }}>
          <ChartErrorBoundary>
            <VegaLiteChart spec={resolvedSpec} />
          </ChartErrorBoundary>
        </Box>
      </CardContent>
    </Card>
  );
}

export default function FullGalleryPage() {
  useScrollSpyHash(exampleIds);
  return (
    <React.Fragment>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 820 }}>
        The same {examples.length} official{' '}
        <Link href="https://vega.github.io/vega-lite/examples/" target="_blank" rel="noreferrer">
          Vega-Lite example gallery
        </Link>{' '}
        specs, but rendered only through <code>&lt;VegaLiteChart /&gt;</code> — no reference panel —
        each at Vega-Lite&apos;s own natural size for that spec rather than a shared
        comparison-column width. Cards tile left to right and wrap, so the page uses as much width
        as it has, and a chart wider than the viewport (a large trellis grid) scrolls within its own
        card instead of squeezing everything else.
      </Typography>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 3,
        }}
      >
        {examples.map((example) => (
          <NativeSizeCard key={example.name} example={example} />
        ))}
      </Box>
    </React.Fragment>
  );
}
