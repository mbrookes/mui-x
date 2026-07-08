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
          <Typography variant="subtitle2" gutterBottom>
            Gaps reported via onGaps ({gaps.length})
          </Typography>
          {gaps.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No untranslatable features — the spec rendered natively.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {gaps.map((gap) => (
                <Box key={`${gap.code}|${gap.path ?? ''}`}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Chip size="small" color={SEVERITY_COLOR[gap.severity]} label={gap.severity} />
                    <Typography variant="body2" component="code" sx={{ fontFamily: 'monospace' }}>
                      {gap.code}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {gap.message}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
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
