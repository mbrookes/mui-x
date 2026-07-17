import * as React from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import CssBaseline from '@mui/material/CssBaseline';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import DemoCard from './DemoCard';
import { demos } from './demos';
import GalleryPage from './gallery/GalleryPage';

const theme = createTheme();

const GALLERY_TAB = 1;

/** The tab implied by the current URL (`?tab=gallery`), so a reload — or a
 * shared link — reopens on the same tab instead of always resetting to the
 * first one. */
function tabFromLocation(): number {
  if (typeof window === 'undefined') {
    return 0;
  }
  return new URLSearchParams(window.location.search).get('tab') === 'gallery' ? GALLERY_TAB : 0;
}

/** Mirrors the active tab into the URL's `tab` query param via `replaceState`
 * (no new history entry per click, and no navigation/scroll side effects). */
function writeTabToLocation(tab: number): void {
  const params = new URLSearchParams(window.location.search);
  if (tab === GALLERY_TAB) {
    params.set('tab', 'gallery');
  } else {
    params.delete('tab');
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

function CuratedDemos() {
  return (
    <React.Fragment>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
        Each card below feeds a Vega-Lite specification and dataset into{' '}
        <code>&lt;VegaLiteChart /&gt;</code> and renders the resulting <code>@mui/x-charts</code>{' '}
        subcomponents. To read like the reference renderer the wrapper reproduces Vega-Lite&apos;s
        defaults (palette, ordering, stack geometry, gridlines, plot-area border, typography) and
        draws marks x-charts has no primitive for — box plots, error bars/bands, text, span rules —
        through custom SVG overlays. Every feature it still cannot translate, and every x-charts
        limitation it works around, is reported live through the <code>onGaps</code> callback below
        each chart, tagged by origin (<code>vega-lite</code> gap vs. <code>x-charts</code>{' '}
        limitation). See <code>GAPS.md</code> for the full support matrix and gap-code index.
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
    </React.Fragment>
  );
}

export default function App() {
  const [tab, setTab] = React.useState(tabFromLocation);

  const handleTabChange = (_event: React.SyntheticEvent, value: number) => {
    setTab(value);
    writeTabToLocation(value);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          @mui/x-charts-vega demo
        </Typography>
        <Tabs value={tab} onChange={handleTabChange} sx={{ mb: 3 }}>
          <Tab label="Curated demos" />
          <Tab label="Vega-Lite gallery" />
        </Tabs>
        {tab === 0 ? <CuratedDemos /> : <GalleryPage />}
      </Container>
    </ThemeProvider>
  );
}
