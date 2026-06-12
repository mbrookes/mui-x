'use client';
import { Chip } from '@mui/material';
import dayjs from 'dayjs';

export function SliderFilterPill({
  filter,
  source,
  onClear,
}: {
  filter: { field: string; value: unknown };
  source: { fields: { id: string; type?: string }[] } | undefined;
  onClear: () => void;
}) {
  const val = filter.value as { from?: string | number; to?: string | number } | null;
  const fieldType = source?.fields.find((f) => f.id === filter.field)?.type;
  const isDate = fieldType === 'date' || fieldType === 'datetime';
  const fmt = (v: string | number | undefined) => {
    if (v == null) {
      return '';
    }
    return isDate ? dayjs(v as string).format('DD MMM YYYY') : Number(v).toLocaleString();
  };
  if (!val) {
    return null;
  }
  return (
    <Chip
      size="small"
      label={`${fmt(val.from)} – ${fmt(val.to)}`}
      onDelete={onClear}
      color="primary"
      variant="outlined"
      sx={{ flexShrink: 0, height: 20, fontSize: 11 }}
    />
  );
}