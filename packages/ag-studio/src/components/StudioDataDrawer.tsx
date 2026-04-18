import * as React from 'react';
import {
  Alert,
  Box,
  Chip,
  Collapse,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import { useStudioSelector } from '../context';
import type { StudioDataSource } from '../models';

const fieldTypeColor: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning'> = {
  string: 'default',
  number: 'primary',
  boolean: 'secondary',
  date: 'success',
  datetime: 'warning',
};

function DataSourceSection(props: { source: StudioDataSource }) {
  const { source } = props;
  const [open, setOpen] = React.useState(true);

  return (
    <Box>
      <ListItemButton onClick={() => setOpen((prev) => !prev)} sx={{ px: 0, py: 0.5 }}>
        <ListItemText
          primary={
            <Typography variant="subtitle2" noWrap>
              {source.label}
            </Typography>
          }
          secondary={`${source.fields.length} field${source.fields.length !== 1 ? 's' : ''} · ${source.rows?.length ?? 0} rows`}
          secondaryTypographyProps={{ variant: 'caption' }}
        />
        {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      </ListItemButton>

      <Collapse in={open}>
        <List dense disablePadding sx={{ pl: 1 }}>
          {source.fields.map((field) => (
            <ListItem key={field.id} disablePadding sx={{ py: 0.25 }}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                      {field.label}
                    </Typography>
                    <Chip
                      label={field.type}
                      size="small"
                      color={fieldTypeColor[field.type] ?? 'default'}
                      variant="outlined"
                      sx={{ height: 16, '& .MuiChip-label': { px: 0.75, fontSize: 10 } }}
                    />
                  </Stack>
                }
              />
            </ListItem>
          ))}
        </List>
      </Collapse>
    </Box>
  );
}

export function StudioDataDrawer() {
  const dataSources = useStudioSelector((state) => state.dataSources);
  const sourceList = Object.values(dataSources);

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
