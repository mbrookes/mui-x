import * as React from 'react';
import {
  Box,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import MenuIcon from '@mui/icons-material/Menu';
import type { SurveyNavSection } from '../config/surveyReport';

export interface SurveyNavProps {
  sections: SurveyNavSection[];
  /** Id of the page currently shown — used to highlight the active section. */
  activePageId: string;
  /** Widget id of the question last navigated to — highlights that item. */
  activeWidgetId?: string | null;
  /** Whether the nav is expanded. When collapsed it shrinks to a slim rail. */
  open: boolean;
  /** Toggle the collapsed/expanded state. */
  onToggle: () => void;
  /**
   * On small screens the expanded nav floats above the canvas (with a dismiss backdrop) instead
   * of pushing the report content, so opening it never squeezes the charts off-screen. The
   * collapsed rail stays in-flow so the expand affordance is always reachable.
   */
  overlay?: boolean;
  /**
   * Called when a question is clicked.
   * @param pageId Page the question lives on.
   * @param n Question number (used in the deep-link URL).
   * @param widgetId Scroll/deep-link target widget id.
   */
  onNavigate: (pageId: string, n: number, widgetId: string) => void;
}

const EXPANDED_WIDTH = 280;
const COLLAPSED_WIDTH = 44;

/**
 * Left side-navigation listing every survey question, grouped by section (page). Clicking a
 * question asks the app to deep-link to it (switch page if needed) and smoothly scroll to it.
 * Can be collapsed to a slim rail via the toggle button.
 */
export function SurveyNav({
  sections,
  activePageId,
  activeWidgetId,
  open,
  onToggle,
  onNavigate,
  overlay = false,
}: SurveyNavProps) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const floating = overlay && open;

  // Keep the highlighted question visible as scrollspy moves it (without scrolling the page).
  React.useEffect(() => {
    if (!activeWidgetId) {
      return;
    }
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-nav-widget="${activeWidgetId}"]`);
    if (!list || !item) {
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.top - listRect.top - listRect.height / 2 + itemRect.height / 2;
    }
  }, [activeWidgetId, open]);

  return (
    <React.Fragment>
      {/* Dismiss backdrop behind the floating nav on small screens. */}
      {floating && (
        <Box
          onClick={onToggle}
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(0, 0, 0, 0.4)',
            zIndex: (theme) => theme.zIndex.drawer - 1,
          }}
        />
      )}
      <Box
        component="nav"
        aria-label="Survey questions"
        sx={{
          width: open ? EXPANDED_WIDTH : COLLAPSED_WIDTH,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          transition: (theme) =>
            theme.transitions.create('width', { duration: theme.transitions.duration.shorter }),
          overflow: 'hidden',
          // When expanded on a small screen, float above the canvas instead of taking flow width.
          ...(floating && {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            height: '100%',
            zIndex: (theme) => theme.zIndex.drawer,
            boxShadow: 6,
          }),
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: open ? 'space-between' : 'center',
            px: open ? 2 : 0,
            py: 1,
            minHeight: 48,
          }}
        >
          {open && (
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Questions
            </Typography>
          )}
          <Tooltip title={open ? 'Collapse' : 'Show questions'} placement="right">
            <IconButton
              size="small"
              onClick={onToggle}
              aria-label={open ? 'Collapse questions navigation' : 'Show questions navigation'}
              aria-expanded={open}
            >
              {open ? <ChevronLeftIcon fontSize="small" /> : <MenuIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>

        {open && (
          <Box ref={listRef} sx={{ overflowY: 'auto', flexGrow: 1, pb: 1 }}>
            {sections.map((section) => {
              const isActiveSection = section.pageId === activePageId;
              return (
                <Box key={section.pageId} sx={{ mb: 1.5 }}>
                  <Typography
                    variant="overline"
                    sx={{
                      display: 'block',
                      px: 2,
                      py: 0.5,
                      lineHeight: 1.4,
                      fontWeight: 700,
                      color: isActiveSection ? 'primary.main' : 'text.secondary',
                    }}
                  >
                    {section.title}
                  </Typography>
                  <List dense disablePadding>
                    {section.questions.map((q) => (
                      <ListItemButton
                        key={q.n}
                        data-nav-widget={q.widgetId}
                        selected={q.widgetId === activeWidgetId}
                        onClick={() => {
                          onNavigate(section.pageId, q.n, q.widgetId);
                          // Dismiss the floating nav on small screens once a question is picked.
                          if (floating) {
                            onToggle();
                          }
                        }}
                        sx={{ alignItems: 'flex-start', py: 0.5, pl: 2, pr: 1.5 }}
                      >
                        <ListItemText
                          primary={`${q.n}. ${q.label}`}
                          title={q.label}
                          slotProps={{
                            primary: {
                              sx: {
                                fontSize: 12,
                                lineHeight: 1.35,
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              },
                            },
                          }}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </React.Fragment>
  );
}
