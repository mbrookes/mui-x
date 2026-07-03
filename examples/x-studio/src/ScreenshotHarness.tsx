import * as React from 'react';
import { Box, CssBaseline, ThemeProvider } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import {
  StudioProvider,
  StudioController,
  StudioComposeDrawer,
  DrawerSubheaderContext,
  DRAWER_WIDTH,
} from '@mui/x-studio';
import { theme } from './theme';
import { SCREENSHOT_SCENARIOS } from './screenshotScenarios';

/**
 * Renders a single `StudioComposeDrawer` setup-panel scenario in isolation, for the
 * doc-effort screenshot harness (see `test/e2e-studio/setupPanelScreenshots.spec.ts`).
 * Activated by `?panelScreenshot=<scenarioId>` — see `main.tsx`.
 */
export default function ScreenshotHarness({ scenarioId }: { scenarioId: string }) {
  const scenario = React.useMemo(
    () => SCREENSHOT_SCENARIOS.find((s) => s.id === scenarioId),
    [scenarioId],
  );

  const controller = React.useMemo(() => {
    if (!scenario) {
      return null;
    }
    const c = new StudioController(scenario.initialState);
    c.setSelectedWidget(scenario.widgetId);
    return c;
  }, [scenario]);

  const [subheader, setSubheader] = React.useState<React.ReactNode>(null);
  const subheaderCtx = React.useMemo(() => ({ setSubheader }), []);

  if (!scenario || !controller) {
    return (
      <Box sx={{ p: 2 }} data-testid="screenshot-error">
        Unknown scenario id: {scenarioId}
      </Box>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <CssBaseline />
        <StudioProvider controller={controller}>
          <DrawerSubheaderContext.Provider value={subheaderCtx}>
            <Box
              data-testid="screenshot-root"
              data-scenario-id={scenario.id}
              sx={{
                width: DRAWER_WIDTH,
                bgcolor: 'background.paper',
                display: 'inline-block',
              }}
            >
              {subheader}
              <Box sx={{ p: 2 }}>
                <StudioComposeDrawer />
              </Box>
            </Box>
          </DrawerSubheaderContext.Provider>
        </StudioProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
