import * as React from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import CssBaseline from '@mui/material/CssBaseline';
import Typography from '@mui/material/Typography';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import DemoCard from './DemoCard';
import { demos } from './demos';

const theme = createTheme();

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          @mui/x-charts-vega demo
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
          Each card below feeds a Vega-Lite specification and dataset into{' '}
          <code>&lt;VegaLiteChart /&gt;</code> and renders the resulting <code>@mui/x-charts</code>{' '}
          subcomponents. Any Vega-Lite feature the wrapper could not translate is reported live
          through the <code>onGaps</code> callback below each chart — most mark compilers are still
          under active development, so an empty or partial chart alongside a populated gap list is
          expected for several of these demos.
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(520px, 1fr))',
            gap: 3,
          }}
        >
          {demos.map((demo) => (
            <DemoCard key={demo.id} demo={demo} />
          ))}
        </Box>
      </Container>
    </ThemeProvider>
  );
}
