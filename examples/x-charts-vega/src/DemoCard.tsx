import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { VegaLiteChart } from '@mui/x-charts-vega';
import type { TranslationGap } from '@mui/x-charts-vega';
import type { Demo } from './demos';

const SEVERITY_COLOR: Record<TranslationGap['severity'], 'error' | 'warning' | 'default'> = {
  unsupported: 'error',
  partial: 'warning',
  ignored: 'default',
};

// A gap's origin: a genuine Vega-Lite coverage gap vs. an x-charts limitation
// the wrapper approximates or works around through a custom component.
const ORIGIN_LABEL: Record<'vega-lite' | 'x-charts', string> = {
  'vega-lite': 'vega-lite',
  'x-charts': 'x-charts',
};

export default function DemoCard({ demo }: { demo: Demo }) {
  // `onGaps` fires from a `useEffect` inside `VegaLiteChart` (on mount, and
  // again whenever the compiled gap signature changes) — capturing it in
  // state here is what makes the gap list "live" rather than a one-shot
  // read of `compileSpec(...).gaps`.
  const [gaps, setGaps] = React.useState<TranslationGap[]>([]);
  const specJson = React.useMemo(() => JSON.stringify(demo.spec, null, 2), [demo.spec]);

  return (
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flexGrow: 1 }}>
        <Box>
          <Typography variant="h6" component="h2">
            {demo.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {demo.description}
          </Typography>
        </Box>

        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <VegaLiteChart
            spec={demo.spec}
            data={demo.data}
            width={480}
            height={320}
            onGaps={setGaps}
          />
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
                    <Stack spacing={1}>
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
                            <Typography variant="caption" color="text.secondary">
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

        <details>
          <summary>
            <Typography variant="caption" component="span" sx={{ cursor: 'pointer' }}>
              Vega-Lite spec (JSON)
            </Typography>
          </summary>
          <Box
            component="pre"
            sx={{
              fontSize: 12,
              overflowX: 'auto',
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1,
              m: 0,
              mt: 1,
            }}
          >
            {specJson}
          </Box>
        </details>
      </CardContent>
    </Card>
  );
}
