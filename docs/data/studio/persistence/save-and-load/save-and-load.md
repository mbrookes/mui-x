---
title: Studio - Save and load
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Save and load

<p class="description">Serialize the entire dashboard state to JSON and restore it later with automatic schema migration.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

Studio's state — pages, widgets, data sources, filters, expression fields — can be serialized to a plain JSON object (`SerializedStudioState`) and restored at any time.
The serialization format is versioned: when you load an older snapshot, Studio migrates it to the current schema automatically.

## Serializing state

Call `serializeState()` on the `StudioHandle` ref:

```ts
const serialized = studioRef.current?.serializeState();
// serialized is a JSON-safe object — safe to stringify and store
```

Persist it anywhere: `localStorage`, a database, a file, or your app's backend.

### Downloading to a file

Use the browser's built-in APIs to trigger a download:

```ts
const serialized = studioRef.current?.serializeState();
if (serialized) {
  const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dashboard.json';
  a.click();
  URL.revokeObjectURL(url);
}
```

## Loading state

Call `loadSerializedState()` on the `StudioHandle` ref:

```ts
const result = studioRef.current?.loadSerializedState(data);
```

This replaces the entire current state (including undo/redo history).

### Handling the result

`loadSerializedState` returns a `MigrationResult`:

```ts
interface MigrationResult {
  success: boolean;
  /** Schema version of the loaded snapshot. */
  fromVersion: number;
  /** Current schema version (the version after migration). */
  toVersion: number;
  /** Non-empty when success is false — describes validation failures. */
  errors: string[];
}
```

Always check `result.success` before assuming the state was loaded:

```ts
const result = studioRef.current?.loadSerializedState(data);
if (!result) return;

if (result.success) {
  if (result.fromVersion !== result.toVersion) {
    showSnackbar(`Loaded and migrated from v${result.fromVersion} to v${result.toVersion}`, 'info');
  } else {
    showSnackbar('Dashboard loaded', 'success');
  }
} else {
  showSnackbar(result.errors.join('; ') || 'Failed to load dashboard', 'error');
}
```

### Loading from a file

Open a file picker, read the file, and pass the parsed JSON to `loadSerializedState`:

```ts
async function handleLoad() {
  const data = await new Promise<unknown>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      try { resolve(JSON.parse(await file.text())); } catch (e) { reject(e); }
    };
    input.click();
  });
  const result = studioRef.current?.loadSerializedState(data);
  // handle result...
}
```

## Save and load buttons — full example

```tsx
import * as React from 'react';
import { Button, Snackbar, Alert } from '@mui/material';
import { Studio } from '@mui/x-studio';
import type { StudioHandle } from '@mui/x-studio';

function uploadJson(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      try { resolve(JSON.parse(await file.text())); } catch (e) { reject(e); }
    };
    input.click();
  });
}

export default function SaveLoadExample() {
  const studioRef = React.useRef<StudioHandle>(null);
  const [snackbar, setSnackbar] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });

  const showMessage = (message: string, severity: 'success' | 'error' | 'info') =>
    setSnackbar({ open: true, message, severity });

  const handleSave = () => {
    const serialized = studioRef.current?.serializeState();
    if (!serialized) return;
    const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: 'dashboard.json' }).click();
    URL.revokeObjectURL(url);
    showMessage('Dashboard saved', 'success');
  };

  const handleLoad = async () => {
    try {
      const data = await uploadJson();
      const result = studioRef.current?.loadSerializedState(data);
      if (!result) return;
      if (result.success) {
        showMessage(
          result.fromVersion !== result.toVersion
            ? `Migrated from v${result.fromVersion} to v${result.toVersion}`
            : 'Dashboard loaded',
          result.fromVersion !== result.toVersion ? 'info' : 'success',
        );
      } else {
        showMessage(result.errors[0] ?? 'Failed to load', 'error');
      }
    } catch {
      showMessage('Load cancelled', 'info');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: '8px 16px', display: 'flex', gap: 8 }}>
        <Button variant="outlined" onClick={handleSave}>Save</Button>
        <Button variant="outlined" onClick={handleLoad}>Load</Button>
      </div>
      <div style={{ flexGrow: 1 }}>
        <Studio ref={studioRef} initialState={myInitialState} />
      </div>
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
      >
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </div>
  );
}
```

## Schema versioning

`SerializedStudioState` carries a `schemaVersion` number.
`CURRENT_SCHEMA_VERSION` is exported so you can check the version in your own storage logic:

```ts
import { CURRENT_SCHEMA_VERSION } from '@mui/x-studio';

console.log(CURRENT_SCHEMA_VERSION); // e.g. 1
```

When you call `loadSerializedState`, Studio runs migration functions for every schema version between the snapshot version and the current version.
Migration is automatic — you don't need to write migration code.

## Lower-level utilities

These are used internally by the Studio controller but are exported for advanced use cases:

| Function | Description |
| :--- | :--- |
| `serializeState(state)` | Converts `StudioState` to `SerializedStudioState` |
| `deserializeState(data)` | Converts `SerializedStudioState` back to `StudioState` |
| `migrateState(data)` | Runs schema migrations and returns `MigrationResult` |
| `stateToJson(state)` | Serializes to a JSON string |
| `jsonToState(json)` | Parses a JSON string to `StudioState` |

## Auto-save to localStorage

Use `onStateChange` to auto-save on every change:

```ts
const handleStateChange = React.useCallback((state: StudioState) => {
  // ...update local UI state...

  // Auto-save (debounce in production to avoid thrashing storage)
  const serialized = studioRef.current?.serializeState();
  if (serialized) {
    localStorage.setItem('studio-dashboard', JSON.stringify(serialized));
  }
}, []);

// On mount, restore from localStorage:
const savedState = React.useMemo<Partial<StudioState> | undefined>(() => {
  const raw = localStorage.getItem('studio-dashboard');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    // migrateState handles version differences
    const result = migrateState(parsed);
    return result.success ? deserializeState(parsed) : undefined;
  } catch {
    return undefined;
  }
}, []);

<Studio ref={studioRef} initialState={savedState} onStateChange={handleStateChange} />
```

## See also

- [State management](/x/react-studio/getting-started/state/) — the `StudioState` shape serialized by `serializeState()`
- [Studio component](/x/react-studio/getting-started/studio/) — `StudioHandle.serializeState()` and `StudioHandle.loadSerializedState()`
- [Async adapters](/x/react-studio/data/async-adapters/) — adapters must be re-attached after loading a serialized state
- [Multi-page](/x/react-studio/features/multi-page/) — page configurations are included in the serialized snapshot
