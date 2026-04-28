'use client';
import * as React from 'react';
import {
  Alert,
  Chip,
  Collapse,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioDataSource } from '../models';

const fieldTypeColor: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning'> =
  {
    string: 'default',
    number: 'primary',
    boolean: 'secondary',
    date: 'success',
    datetime: 'warning',
  };

function DataSourceSection(props: { source: StudioDataSource }) {
  const { source } = props;
  const [open, setOpen] = React.useState(true);
  const controller = useStudioController();
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
  const selectedSourceId = useStudioSelector((state) => state.shell.selectedSourceId);

  return (
    <div>
      <ListItemButton onClick={() => setOpen((prev) => !prev)} sx={{ px: 0, py: 0.5 }}>
        <ListItemText
          primary={
            <Typography variant="subtitle2" noWrap>
              {source.label}
            </Typography>
          }
          secondary={
            <Typography variant="caption" color="text.secondary">
              {source.fields.filter((f) => !f.hidden).length} field
              {source.fields.filter((f) => !f.hidden).length !== 1 ? 's' : ''} ·{' '}
              {source.rows?.length ?? 0} rows
            </Typography>
          }
        />
        {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      </ListItemButton>

      <Collapse in={open}>
        <List dense disablePadding sx={{ pl: 1 }}>
          {source.fields
            .filter((f) => !f.hidden)
            .map((field) => {
              const isSelected = selectedSourceId === source.id && selectedFieldId === field.id;
              return (
                <ListItemButton
                  key={field.id}
                  selected={isSelected}
                  onClick={() => controller.selectField(source.id, field.id)}
                  sx={{ borderRadius: 1, py: 0.25, px: 0.75 }}
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                          {field.label}
                        </Typography>
                        <Chip
                          label={field.type}
                          size="small"
                          color={fieldTypeColor[field.type] ?? 'default'}
                          variant="outlined"
                          sx={{
                            alignSelf: 'center',
                            height: 16,
                            '& .MuiChip-label': {
                              px: 0.75,
                              fontSize: 10,
                              display: 'flex',
                              alignItems: 'center',
                              height: '100%',
                            },
                          }}
                        />
                      </Stack>
                    }
                  />
                </ListItemButton>
              );
            })}
        </List>
      </Collapse>
    </div>
  );
}

export function StudioDataDrawer() {
  const dataSources = useStudioSelector((state) => state.dataSources);
  const sourceList = Object.values(dataSources).filter((s) => !s.hidden);

  if (sourceList.length === 0) {
    return (
      <Alert severity="info" sx={{ mt: 1 }}>
        No data sources configured. Add a widget from the canvas to load sample data.
      </Alert>
    );
  }

  return (
    <Stack spacing={0}>
      {sourceList.map((source) => (
        <DataSourceSection key={source.id} source={source} />
      ))}
    </Stack>
  );
}
