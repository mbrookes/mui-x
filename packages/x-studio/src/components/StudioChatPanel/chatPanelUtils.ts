import type { SxProps, Theme } from '@mui/material';

// Normalize an optional `sx` prop into an array of sx entries so it can be spread into a
// combined `sx={[...]}` array. The element type excludes the array form of `SxProps` so the
// result is directly spreadable into MUI's `sx` array prop without nesting.
export type SxEntry = Exclude<SxProps<Theme>, ReadonlyArray<unknown>>;

export function toSxArray(sx: SxProps<Theme> | undefined): SxEntry[] {
  if (Array.isArray(sx)) {
    return sx as SxEntry[];
  }
  return sx ? [sx as SxEntry] : [];
}
