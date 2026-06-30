import * as React from 'react';
import { Box, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import type { SurveyNavSection } from '../config/surveyReport';

export interface SurveyNavProps {
  sections: SurveyNavSection[];
  /** Id of the page currently shown — used to highlight the active section. */
  activePageId: string;
  /** Widget id of the question last navigated to — highlights that item. */
  activeWidgetId?: string | null;
  /**
   * Called when a question is clicked.
   * @param pageId Page the question lives on.
   * @param n Question number (used in the deep-link URL).
   * @param widgetId Scroll/deep-link target widget id.
   */
  onNavigate: (pageId: string, n: number, widgetId: string) => void;
}

/**
 * Left side-navigation listing every survey question, grouped by section (page). Clicking a
 * question asks the app to deep-link to it (switch page if needed) and smoothly scroll to it.
 */
export function SurveyNav({ sections, activePageId, activeWidgetId, onNavigate }: SurveyNavProps) {
  return (
    <Box
      component="nav"
      aria-label="Survey questions"
      sx={{
        width: 280,
        flexShrink: 0,
        overflowY: 'auto',
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        py: 1,
      }}
    >
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
                  selected={q.widgetId === activeWidgetId}
                  onClick={() => onNavigate(section.pageId, q.n, q.widgetId)}
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
  );
}
