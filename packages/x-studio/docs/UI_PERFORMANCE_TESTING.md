# Comprehensive UI Performance Review

## For MUI X Studio (React + MUI + MUI X)

---

## Executive Summary

A thorough UI performance review for a React/MUI X dashboard app has five interlocking dimensions: **(1) Lab metrics** (Lighthouse scores, trace-based Core Web Vitals captured via the existing `chrome-devtools-mcp`); **(2) Real-user measurement** (RUM via the `web-vitals` library deployed in production); **(3) React-specific profiling** (`react-scan` for live re-render visibility, `@welldone-software/why-did-you-render` for root-cause analysis, React DevTools Profiler flamegraphs); **(4) Bundle analysis** (`rollup-plugin-visualizer` in Vite config); and **(5) MUI X-specific tuning** (DataGrid virtualization, `sx` prop avoidance on hot paths, chart `skipAnimation`, store-based context). The existing `chrome-devtools-mcp` already covers performance traces and heap snapshots. Three additional MCP servers — `@danielsogl/lighthouse-mcp`, `@playwright/mcp`, and `cdp-extended-mcp` — fill the gaps for Lighthouse scoring, test orchestration, and CPU profiling / CSS coverage respectively.

---

## Table of Contents

1. [Priority Matrix — What to Measure First](#1-priority-matrix)
2. [MCP Tool Stack](#2-mcp-tool-stack)
3. [React-Specific Dev Tools](#3-react-specific-dev-tools)
4. [Bundle Analysis](#4-bundle-analysis)
5. [Real-User Monitoring (RUM)](#5-real-user-monitoring)
6. [Core Web Vitals Reference](#6-core-web-vitals-reference)
7. [React Performance Pitfalls Checklist](#7-react-performance-pitfalls-checklist)
8. [MUI X-Specific Performance Guide](#8-mui-x-specific-performance-guide)
9. [Performance Review Session Playbook](#9-performance-review-session-playbook)
10. [All Tools — Quick Reference](#10-all-tools-quick-reference)
11. [Confidence Assessment](#confidence-assessment)

---

## 1. Priority Matrix

For a dashboard application, metrics rank by user impact:

```
INP  ████████████████████  #1 — Every interaction (sort, filter, date change)
LCP  ██████████████        #2 — Initial perceived load
CLS  ████████              #3 — Layout stability during data load
FCP  ██████                #4 — App shell appearance
TTFB █████                 #5 — Infrastructure (CDN, server)
```

### Core Web Vitals Thresholds

| Metric                          | Good    | Needs Work | Poor    |
| ------------------------------- | ------- | ---------- | ------- |
| INP (Interaction to Next Paint) | ≤ 200ms | 200–500ms  | > 500ms |
| LCP (Largest Contentful Paint)  | ≤ 2.5s  | 2.5–4.0s   | > 4.0s  |
| CLS (Cumulative Layout Shift)   | ≤ 0.1   | 0.1–0.25   | > 0.25  |
| FCP (First Contentful Paint)    | ≤ 1.8s  | 1.8–3.0s   | > 3.0s  |
| TTFB (Time to First Byte)       | ≤ 0.8s  | 0.8–1.8s   | > 1.8s  |

**INP replaced FID as a Core Web Vital in March 2024.**[^1] Unlike FID (which measured only the _first_ interaction's input delay), INP observes **all qualifying interactions** (click, tap, keyboard) throughout the page's lifetime and reports the worst-performing one (excluding top 1/50 outliers). Every data grid sort, filter chip click, or date range change contributes.

---

## 2. MCP Tool Stack

### What You Already Have: `chrome-devtools-mcp`

The official Google package (`ChromeDevTools/chrome-devtools-mcp`, npm `chrome-devtools-mcp@1.0.1`, Apache-2.0) provides 45 tools across 10 categories.[^2] It is the primary performance investigation tool.

#### Performance-Critical MCP Tools (existing)

**Performance traces** — `performance_start_trace` / `performance_stop_trace`

Records a Chrome DevTools-identical performance trace using CDP `Tracing` domain with categories including `devtools.timeline`, `v8.cpu_profiler`, `latencyInfo` (INP), and `disabled-by-default-devtools.timeline.frame`.[^3]

```
1. navigate_page(url="http://localhost:3000")
2. performance_start_trace(reload=true, autoStop=true)
   // ← auto-navigates to about:blank, reloads page, waits 5s, stops, parses CrUX
3. performance_analyze_insight(insightSetId="<id>", insightName="LCPBreakdown")
4. performance_analyze_insight(insightSetId="<id>", insightName="TBT")
5. performance_analyze_insight(insightSetId="<id>", insightName="INP")
```

For interaction-specific traces (e.g., profiling a DataGrid sort):

```
1. navigate_page(url="http://localhost:3000")
2. performance_start_trace(reload=false, autoStop=false)
3. take_snapshot()           // get element UIDs
4. click(uid="sort-btn-123") // perform the interaction
5. wait_for(text=["Sorted"])
6. performance_stop_trace(filePath="sort-trace.json.gz")
   // Open in chrome://tracing or Perfetto UI for flame chart
```

**Heap memory snapshots** — requires `--experimentalMemory=true` flag in MCP config[^4]

```
1. take_heapsnapshot(filePath="before.heapsnapshot")
2. // interact with app (open/close widgets, navigate pages)
3. evaluate_script(function="() => { window.gc && window.gc() }")  // force GC
4. take_heapsnapshot(filePath="after.heapsnapshot")
5. get_heapsnapshot_summary(filePath="after.heapsnapshot")
6. get_heapsnapshot_details(filePath="after.heapsnapshot")
7. get_heapsnapshot_class_nodes(filePath="after.heapsnapshot", id=<class_id>)
8. get_heapsnapshot_retainers(filePath="after.heapsnapshot", nodeId=<node_id>)
```

**Throttled simulation** — `emulate`

```
emulate(cpuThrottlingRate=4, networkConditions="Slow 4G", viewport="390x844x3,mobile,touch")
// cpuThrottlingRate=4 simulates median Android device
// Reset with: emulate()
```

**Lighthouse** — `lighthouse_audit`[^5]

> ⚠️ The MCP's `lighthouse_audit` **excludes the performance category** by design. It covers accessibility, SEO, and best-practices only. Performance scoring requires `performance_start_trace`.

```
lighthouse_audit(mode="navigation", device="desktop")
lighthouse_audit(mode="navigation", device="mobile")  // 412×823, 1.75× DPR
```

**Network analysis** — `list_network_requests` / `get_network_request`

```
list_network_requests(resourceTypes=["script","stylesheet"])  // find large bundles
list_network_requests(resourceTypes=["xhr","fetch"])          // find slow API calls
get_network_request(reqid=42)  // DNS → connect → SSL → TTFB → download timing
```

#### Update Your MCP Config

Enable heap analysis by adding `--experimentalMemory=true`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--isolated=true",
        "--experimentalMemory=true",
        "--viewport=1920x1080"
      ]
    }
  }
}
```

---

### Additional MCP Tools to Install

#### 🏆 `@danielsogl/lighthouse-mcp` — Synthetic Scores + Bundle Analysis

**GitHub:** `danielsogl/lighthouse-mcp-server` | **npm:** `@danielsogl/lighthouse-mcp` | **Stars:** 58[^6]

Fills the Lighthouse performance gap. Provides 13 tools including **actual Lighthouse performance scores** (0–100), unused JavaScript analysis, and CI-style budget enforcement.

```bash
# Install (no project install needed — runs via npx)
# Add to MCP config:
```

```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "npx",
      "args": ["@danielsogl/lighthouse-mcp@latest", "--chrome-port", "9222"]
    }
  }
}
```

**Key tools:**

| Tool                       | What It Returns                                          |
| -------------------------- | -------------------------------------------------------- |
| `get_performance_score`    | Lighthouse score + FCP, LCP, TBT, CLS, Speed Index, TTI  |
| `get_core_web_vitals`      | LCP/INP/CLS with configurable pass/fail thresholds       |
| `compare_mobile_desktop`   | Side-by-side score diff                                  |
| `check_performance_budget` | Custom budget: `{ lcp: 2500, cls: 0.1, tbt: 200 }`       |
| `get_lcp_opportunities`    | LCP element + specific actionable recommendations        |
| `find_unused_javascript`   | Per-file: total KB, unused KB, unused %, recommendations |
| `analyze_resources`        | All JS/CSS/image/font resources with size + priority     |
| `run_audit`                | Full audit (perf + a11y + SEO + best practices)          |

**Important:** Both Lighthouse MCP and chrome-devtools-mcp can attach to the same Chrome instance via `--chrome-port 9222`. Launch Chrome with `--remote-debugging-port=9222` to enable this.

---

#### `@playwright/mcp` — Multi-Step Flow Orchestration + Tracing

**GitHub:** `microsoft/playwright-mcp` | **npm:** `@playwright/mcp` | **Stars:** 32,827[^7]

Best for orchestrating realistic user flows before measuring performance (e.g., "log in, navigate to dashboard, open a filter, sort the grid, measure INP").

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--caps=devtools,network"]
    }
  }
}
```

**Performance-relevant tools:**

| Tool                                             | Performance Use Case                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `browser_start_tracing` / `browser_stop_tracing` | Playwright trace files (open with `npx playwright show-trace`)   |
| `browser_network_requests`                       | All requests since page load                                     |
| `browser_evaluate`                               | Run `performance.getEntriesByType('navigation')` or custom marks |
| `browser_route`                                  | Mock slow APIs to test skeleton states and error handling        |
| `browser_network_state_set`                      | Test offline / cached-asset behavior                             |
| `browser_take_screenshot`                        | Before/after visual regression                                   |

---

#### `cdp-extended-mcp` — CPU Profiling + CSS Coverage (fills exact chrome-devtools-mcp gaps)

**GitHub:** `MahyarNemati/cdp-extended-mcp` | **npm:** `cdp-extended-mcp`[^8]

> ⚠️ 0 stars, new (April 2026). Evaluate before production workflow adoption.

Explicitly designed as a companion to chrome-devtools-mcp. Adds the 5 CDP domains the existing tool doesn't expose:

```json
{
  "mcpServers": {
    "cdp-extended": {
      "command": "npx",
      "args": ["cdp-extended-mcp"]
    }
  }
}
```

**Performance additions:**

| Domain      | Tool                                            | What It Adds                                                         |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Performance | `perf_metrics`                                  | Raw runtime: JS heap, DOM nodes, layout count, style recalc count    |
| Performance | `perf_cpu_profile_start` / `stop`               | CPU profiling with hotspot analysis                                  |
| Performance | `perf_heap_snapshot`                            | Memory snapshot (simpler than chrome-devtools-mcp's heap tools)      |
| CSS         | `css_coverage_start` / `stop`                   | **Used vs. unused CSS per file** — critical for MUI/Emotion analysis |
| CSS         | `css_computed_style`                            | Final computed styles for any element                                |
| Fetch       | `fetch_enable` / `fetch_fulfill` / `fetch_fail` | Request interception for testing loading states                      |
| Emulation   | `emulate_reduced_motion`                        | Test `prefers-reduced-motion` animation behavior                     |

**CSS coverage is particularly relevant for MUI X** — Emotion generates many class names at runtime, and CSS coverage reveals how much of that generated CSS is actually applied.[^8]

---

### Complete MCP Config

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--isolated=true",
        "--experimentalMemory=true",
        "--viewport=1920x1080"
      ]
    },
    "lighthouse": {
      "command": "npx",
      "args": ["@danielsogl/lighthouse-mcp@latest", "--chrome-port", "9222"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--caps=devtools,network"]
    },
    "cdp-extended": {
      "command": "npx",
      "args": ["cdp-extended-mcp"]
    }
  }
}
```

---

## 3. React-Specific Dev Tools

These are **development-only** tools installed in the project.

### 3a. `react-scan` — Live Visual Re-render Overlay

**npm:** `react-scan` | **Version:** `0.5.6` | **GitHub:** `aidenybai/react-scan`[^9]

Visually highlights every component that re-renders — **as it happens**, without recording sessions. The MUI DataGrid has many internally memo'd components; react-scan shows which ones are actually re-rendering during interactions.

```bash
npm install -D react-scan
```

**Vite setup — add to `index.html`** (before any other scripts):

```html
<head>
  <!-- dev only: react-scan re-render overlay -->
  <script crossorigin="anonymous" src="//unpkg.com/react-scan/dist/auto.global.js"></script>
</head>
```

Or gate on dev mode in `src/main.tsx`:

```ts
// src/main.tsx
if (import.meta.env.DEV) {
  const { scan } = await import('react-scan');
  scan({ enabled: true, log: false });
}
```

**Full options:**

```ts
import { scan, setOptions } from 'react-scan';
scan({
  enabled: true,
  log: false, // log to console
  showToolbar: true, // on-page toolbar
  animationSpeed: 'fast',
  onRender: (fiber, renders) => {
    // programmatic access to every render event
  },
});
// Change at runtime:
setOptions({ enabled: false }); // disable before perf measurements
```

> ⚠️ **MUI DataGrid note:** `DataGridVirtualScroller` and cell components re-render continuously during scroll — this is expected (virtualization working correctly). Use `setOptions({ enabled: false })` before scroll benchmarks; re-enable to isolate true regressions.[^9]

---

### 3b. `@welldone-software/why-did-you-render` — Root Cause Re-render Analysis

**npm:** `@welldone-software/why-did-you-render` | **Version:** `10.0.1`[^10]

Reports _why_ a component re-rendered — which prop/state/hook/context changed. Critical for finding the "something upstream is creating a new object reference every render" class of bugs.

```bash
npm install --save-dev @welldone-software/why-did-you-render
```

> ⚠️ **Never use in production.** Makes the app significantly slower. Not compatible with React Compiler.

**Setup — create `src/wdyr.ts` (must be first import in entrypoint):**

```ts
// src/wdyr.ts
/// <reference types="@welldone-software/why-did-you-render" />
import React from 'react';

if (process.env.NODE_ENV === 'development') {
  const { default: whyDidYouRender } = await import('@welldone-software/why-did-you-render');
  whyDidYouRender(React, {
    trackAllPureComponents: true, // all React.memo + PureComponent
    trackHooks: true,
    logOwnerReasons: true, // show why the PARENT re-rendered too
    collapseGroups: false,
    // Scope to specific components to avoid console noise:
    // include: [/StudioWidgetCard/, /FormatPanel/],
    // exclude: [/^ConnectFunction/, /DataGrid/],
  });
}
```

```ts
// src/main.tsx
import './wdyr'; // ⚠️ MUST be line 1
import React from 'react';
// ... rest of app
```

**Enable per component:**

```ts
const MyWidget = (props) => {
  /* ... */
};
MyWidget.whyDidYouRender = true;

// Or with advanced config:
MyWidget.whyDidYouRender = {
  logOnDifferentValues: true,
  customName: 'MyWidget',
};
```

> **MUI-specific:** Use `include: [/YourComponent/]` rather than `trackAllPureComponents: true` — the DataGrid has hundreds of internal memo'd cells that will flood the console. Focus on your own components.[^10]

---

### 3c. React DevTools Profiler (Browser Extension)

**Install:** Chrome Web Store → search "React Developer Tools" (by Meta)

After installation, a **⚛️ Profiler** tab appears in DevTools.

**Key settings to enable:**

- Profiler → ⚙️ → ✅ **"Record why each component rendered"** — shows _Props changed / State changed / Hooks changed / Context changed_ for each bar
- Components → ⚙️ → ✅ **"Highlight updates when components render"** — blue/red flash overlay (similar to react-scan but built-in)

**Reading the flamegraph:**

```
Key rules:
- Bar WIDTH = render time (wider = slower)
- Bar COLOUR = yellow (expensive) → blue (cheap) → grey (did not render)
- Click any bar → "Why did this render?" panel
- "Ranked" tab = flat list, slowest component at top
```

**To profile production builds** (profiling is stripped by default in production):

```ts
// vite.config.ts — use profiling builds
resolve: {
  alias: {
    'react-dom$': 'react-dom/profiling',
    'scheduler/tracing': 'scheduler/tracing-profiling',
  }
}
```

---

### 3d. React `<Profiler>` Component — Programmatic Monitoring

**Source:** React docs[^11]

Works in development and profiling builds. Useful for automated regression detection or production sampling.

```tsx
import { Profiler } from 'react';

function onRender(
  id: string, // "DataGrid" — which Profiler
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number, // ms spent in this commit
  baseDuration: number, // ms without any memoization (worst case)
  startTime: number,
  commitTime: number,
) {
  // actualDuration << baseDuration = memoization working ✅
  // actualDuration ≈ baseDuration  = memoization broken  ❌
  if (actualDuration > 16) {
    console.warn(
      `[Perf] ${id} [${phase}]: ${actualDuration.toFixed(1)}ms (base: ${baseDuration.toFixed(1)}ms)`,
    );
  }
}

<Profiler id="DataGrid" onRender={onRender}>
  <DataGrid rows={rows} columns={columns} />
</Profiler>;
```

**For production monitoring (with sampling):**

```ts
function onRender(id, phase, actualDuration, baseDuration) {
  if (Math.random() < 0.01 && actualDuration > 16) {
    // 1% sample, >1 frame
    analytics.track('slow_render', {
      component: id,
      phase,
      actualDuration,
      memoEfficiency: baseDuration > 0 ? 1 - actualDuration / baseDuration : 0,
    });
  }
}
```

---

## 4. Bundle Analysis

### `rollup-plugin-visualizer` (Vite-native)

**npm:** `rollup-plugin-visualizer` | **Version:** `7.0.1` | **Requires:** Node ≥ 22[^12]

```bash
npm install --save-dev rollup-plugin-visualizer
```

```ts
// vite.config.ts
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    // ... other plugins
    visualizer({
      filename: 'stats.html',
      open: true, // auto-open after build
      template: 'treemap', // treemap | sunburst | flamegraph | network | list
      gzipSize: true,
      brotliSize: true,
      sourcemap: true, // requires sourcemap: true in build
    }) as PluginOption,
  ],
  build: {
    sourcemap: true, // needed for accurate sizes
  },
});
```

**Which template to use:**
| Template | Best for |
|----------|---------|
| `treemap` | "Find the largest modules fast" |
| `network` | "Why is this library included?" (shows import graph) |
| `list` | CI-diffable YAML output — commit and track over time |

**Colour coding:** Blue = your code. Green = `node_modules`.

### One-shot without modifying config

```bash
npx vite-bundle-visualizer             # treemap (default)
npx vite-bundle-visualizer -t network  # import graph
npx vite-bundle-visualizer --sourcemap # accurate sizes
```

### `source-map-explorer` — Post-build, source-map-accurate

**npm:** `source-map-explorer` | **Version:** `2.5.3`[^13]

Best for: detecting **duplicate library copies** (two versions of React, duplicate lodash), and integrating with Chrome coverage JSON to see which bytes were actually executed.

```bash
npm install --save-dev source-map-explorer
```

After `vite build` (with `sourcemap: true`):

```bash
npx source-map-explorer 'dist/assets/*.js'
npx source-map-explorer 'dist/assets/*.js' --html bundle.html
```

Add as an npm script:

```json
{
  "scripts": {
    "bundle:analyze": "source-map-explorer 'dist/assets/*.js' --html bundle-analysis.html"
  }
}
```

---

## 5. Real-User Monitoring (RUM)

### `web-vitals` Library

**npm:** `web-vitals` | **Version:** `5.2.0` | **GitHub:** `GoogleChrome/web-vitals`[^14]

Measures Core Web Vitals with the exact same methodology Chrome uses for CrUX/PageSpeed Insights. ~2KB brotli'd. **Add to production builds.**

```bash
npm install web-vitals
```

**Basic setup — `src/reportWebVitals.ts`:**

```ts
import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';
import type { Metric } from 'web-vitals';

function sendToAnalytics(metric: Metric) {
  navigator.sendBeacon(
    '/analytics/vitals',
    JSON.stringify({
      name: metric.name,
      id: metric.id,
      value: metric.value,
      delta: metric.delta,
      rating: metric.rating, // 'good' | 'needs-improvement' | 'poor'
    }),
  );
}

export function reportWebVitals() {
  onCLS(sendToAnalytics);
  onINP(sendToAnalytics);
  onLCP(sendToAnalytics);
  onFCP(sendToAnalytics);
  onTTFB(sendToAnalytics);
}
```

**Attribution build** — identifies the _specific element/interaction_ causing the metric:

```ts
import { onINP, onLCP, onCLS } from 'web-vitals/attribution';

onINP(({ name, value, attribution }) => {
  // Which element was interacted with?
  console.log('INP element:', attribution.interactionTarget);
  console.log('Input delay:', attribution.inputDelay); // ms waiting for main thread
  console.log('Processing:', attribution.processingDuration); // ms in event handlers
  console.log('Presentation delay:', attribution.presentationDelay); // ms to next paint
});

onLCP(({ value, attribution }) => {
  // Which element is the LCP candidate?
  console.log('LCP element:', attribution.target);
  console.log('LCP breakdown:', {
    ttfb: attribution.timeToFirstByte,
    resourceLoadDelay: attribution.resourceLoadDelay,
    resourceLoadDuration: attribution.resourceLoadDuration,
    elementRenderDelay: attribution.elementRenderDelay,
  });
});
```

> The INP attribution's `interactionTarget` will pinpoint exactly which DataGrid column header, filter chip, or button is causing slow interactions.[^14]

---

## 6. Core Web Vitals Reference

### INP — Most Critical for Dashboards

**Source:** [web.dev/articles/inp][^1] and [web.dev/articles/optimize-inp][^15]

An interaction's total latency = **input delay** + **processing duration** + **presentation delay**

- **Input delay** — long tasks on the main thread _before_ event handlers run. Caused by large bundles evaluating, or previous interactions not yet complete.
- **Processing duration** — time in event callback code. A `onClick` that does synchronous filtering/sorting of 10,000 rows lands here.
- **Presentation delay** — time from callbacks finishing to next paint. Large DOMs, CSS recalculation, layout thrashing.

**Optimization pattern — yield non-visual work:**

```js
async function handleSort() {
  updateSortIndicator(); // visual-critical — runs first

  await scheduler.yield(); // yields to browser; continuation is prioritized

  sortDataInplace(); // non-visual — deferred
  await scheduler.yield();
  updateRowOrder();
}

// Fallback for browsers without scheduler.yield():
const yieldToMain = () => globalThis.scheduler?.yield?.() ?? new Promise((r) => setTimeout(r, 0));
```

**Budget rule:** any task > 50ms is a "long task" and blocks user input. The Performance panel shows these with red triangles.

---

## 7. React Performance Pitfalls Checklist

### 7.1 Unnecessary Re-renders

- [ ] **Inline object/array props** — `<DataGrid columns={[...]} />` creates a new array every render, breaking `React.memo`. Define `columns` at module level or `useMemo`.
- [ ] **Inline function props** — `onSortChange={() => fn(...)}` creates a new function ref each render. Use `useCallback`.
- [ ] **Context value instability** — `<ThemeProvider theme={createTheme({...})}>` recreates the theme every render, causing every `useTheme()` consumer to re-render. Memoize with `useMemo`.
- [ ] **Missing `React.memo`** — components that receive stable props but re-render because their parent does.

**Detection:** react-scan (visual) → why-did-you-render (root cause) → React DevTools Profiler "Why did this render?" (confirmation)

### 7.2 Long Tasks in Event Handlers

- [ ] No synchronous heavy computation in click/keydown handlers
- [ ] Use `scheduler.yield()` or `rAF + setTimeout` to break work > 50ms
- [ ] Long tasks visible in Performance panel (red triangle on task bar)

### 7.3 Layout Thrashing

```js
// BAD — forces layout each iteration (alternates read/write)
elements.forEach((el) => {
  el.style.width = container.offsetWidth + 'px';
});

// GOOD — batch reads, then writes
const width = container.offsetWidth; // single read
elements.forEach((el) => {
  el.style.width = width + 'px';
});
```

- [ ] No `useLayoutEffect` that reads layout properties _and_ sets state synchronously
- [ ] Animations use `transform`/`opacity` (GPU-composited), not `top`/`left`/`width`/`height`

### 7.4 Memory Leaks

```tsx
useEffect(() => {
  const handler = () => onResize();
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler); // ← cleanup required
}, [onResize]);
```

- [ ] All `useEffect` cleanups remove event listeners, timers, subscriptions
- [ ] `ResizeObserver`, `IntersectionObserver`, `MutationObserver` → `observer.disconnect()` on unmount

### 7.5 Bundle Size

- [ ] Route-level code splitting with `React.lazy` + `Suspense`
- [ ] Lazy-load heavy components (DataGrid, Charts, DatePicker) only when their view mounts
- [ ] Analyze with `rollup-plugin-visualizer` — look for duplicate packages
- [ ] No `import *` from large libraries

---

## 8. MUI X-Specific Performance Guide

### 8.1 DataGrid Virtualization

**Source:** `mui/mui-x:packages/x-data-grid/src/constants/dataGridPropsDefaultValues.ts`[^16]

```ts
// Current defaults (v7+) — pixel-based
columnBufferPx: 150,   // pixels of columns outside viewport to render
rowBufferPx: 150,      // pixels of rows outside viewport to render
rowHeight: 52,         // default row height
```

**Critical warning — `getRowHeight` disables column virtualization:**[^17]

```tsx
// ❌ This disables column virtualization (all columns rendered):
<DataGrid getRowHeight={() => 'auto'} />

// ✅ Re-enable column virtualization (tradeoff: height may reflow on h-scroll):
<DataGrid
  getRowHeight={() => 'auto'}
  virtualizeColumnsWithAutoRowHeight={true}
/>
```

**`disableVirtualization` is testing-only:**[^17]

```tsx
// ❌ NEVER in production — renders ALL rows at once (O(n) DOM nodes)
<DataGrid disableVirtualization />

// ✅ For production large datasets: server-side pagination or filtering
<DataGrid filterMode="server" sortingMode="server" paginationMode="server" />
```

**Historical benchmarks** (directionally valid):[^18]

| Scenario | Rows    | Sort time    | Filter time  |
| -------- | ------- | ------------ | ------------ |
| DataGrid | 100     | 40ms         | 63ms         |
| DataGrid | 10,000  | 83ms         | 115ms        |
| DataGrid | 100,000 | **563ms ❌** | **392ms ❌** |

→ At 100k rows, `sortingMode="server"` and `filterMode="server"` are mandatory for acceptable INP.

### 8.2 DataGrid Memoization Requirements

**Source:** `mui/mui-x:docs/data/data-grid/performance/performance.md`[^19]

```tsx
// ❌ BAD — new object every render, DataGrid.memo() fails
function Component({ rows, someValue }) {
  return (
    <DataGrid
      rows={rows}
      slots={{ row: CustomRow }}                           // new object ❌
      cellModesModel={{ [rows[0].id]: { name: {...} } }}  // new object ❌
      onCellClick={() => handleClick(someValue)}           // new function ❌
    />
  );
}

// ✅ GOOD
const slots = { row: CustomRow }; // module-level (never changes)

function Component({ rows, someValue }) {
  const handleClick = React.useCallback(
    (params) => handleClickImpl(params, someValue),
    [someValue],
  );
  const cellModesModel = React.useMemo(
    () => ({ [rows[0].id]: { name: { mode: GridCellModes.Edit } } }),
    [rows],
  );
  const columns = React.useMemo(
    () => [{ field: 'id' }, { field: 'name', renderCell: ... }],
    [/* stable deps */],
  );
  return <DataGrid rows={rows} slots={slots} cellModesModel={cellModesModel}
                   columns={columns} onCellClick={handleClick} />;
}
```

**The `columns` prop is especially critical** — unstable column array references cause column width/order resets on every render.[^19]

### 8.3 `sx` Prop Performance

**Source:** MUI official benchmarks[^20]

| Approach                       | Render Time | Relative Cost |
| ------------------------------ | ----------- | ------------- |
| `<div className="...">`        | 100ms       | 1.0× baseline |
| `<StyledDiv>` (emotion styled) | 181ms       | 1.8×          |
| `<Box sx={...}>`               | **296ms**   | **~3×**       |

```tsx
// ❌ BAD on hot render paths (list rows, table cells, frequently-updating values)
<Box sx={{ color: liveColor }} />

// ✅ GOOD — CSS variable: no new style injection on every change
<div style={{ '--live-color': liveColor } as React.CSSProperties}
     className={styles.coloredBox} />

// ✅ GOOD — styled() for reusable components
const ColoredBox = styled('div')(({ theme }) => ({
  color: theme.palette.primary.main,
}));
```

**Rule of thumb:** `sx` is fine for one-off layout wrappers. For components rendered many times (DataGrid cells, chart elements, list rows) — use `styled()` or plain CSS.

### 8.4 ThemeProvider

```tsx
// ❌ BAD — new theme object every render → every useTheme() consumer re-renders
function App() {
  const [mode, setMode] = useState('light');
  const theme = createTheme({ palette: { mode } }); // recreated every render!
  return <ThemeProvider theme={theme}>...</ThemeProvider>;
}

// ✅ GOOD — memoize
function App() {
  const [mode, setMode] = useState('light');
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);
  return <ThemeProvider theme={theme}>...</ThemeProvider>;
}
```

### 8.5 Charts Performance

**Source:** `mui/mui-x:packages/x-charts`[^21]

MUI X Charts renders with **SVG** (Canvas is a tracked future goal[^22]). Performance implications:

- SVG elements have per-node DOM cost — at > ~1,000 points per series, performance can degrade
- Pre-aggregate/sample data before passing to charts for large datasets

```tsx
// Disable animations during rapid data updates:
<BarChart skipAnimation={isLiveUpdating} />

// For large scatter datasets — uses SVG arc-path batching (1000 points per <path>):
<ScatterChart renderer="svg-batch" series={[{ data: largeDataset }]} />

// For very large datasets (200k+ points) — WebGL renderer (Premium):
<ScatterChartPremium renderer="webgl" series={[{ data: twoHundredKPoints }]} />
```

**Animation performance tip:** MUI X Charts uses imperative DOM attribute updates for animation frames (bypassing React reconciliation). Only initial render and data changes trigger React renders — animation frames are ~free from React's perspective.[^21]

### 8.6 Studio / Context Architecture

**Source:** `mui/mui-x:packages/x-studio/src/context/`[^23]

x-Studio uses `useSyncExternalStore` via a shared `Store<State>` class (same pattern as Zustand) rather than raw React Context for state. The context holds the **controller reference** (always stable), not the state. Components subscribe individually via `useStudioSelector`.

```ts
// ✅ Use module-level selectors — inline arrows break useSyncExternalStore in React 19
export const selectMode = (state: StudioState) => state.mode;
export const selectFilters = (state: StudioState) => state.filters;

// In components:
const mode = useStudioSelector(selectMode); // ✅
const mode = useStudioSelector((s) => s.mode); // ❌ — new fn reference every render
```

**For selectors returning arrays** — use the closure-based memoization pattern to prevent `[]!==[]` re-renders when content is identical.[^23]

---

## 9. Performance Review Session Playbook

### Phase 1: Baseline (30 min)

```
1. Run Lighthouse via MCP (lighthouse MCP):
   get_performance_score(url="http://localhost:3000")
   compare_mobile_desktop(url="http://localhost:3000")

2. Capture lab CWVs via chrome-devtools-mcp:
   performance_start_trace(reload=true, autoStop=true)
   performance_analyze_insight(insightName="LCPBreakdown")
   performance_analyze_insight(insightName="TBT")

3. Set throttling to replicate mid-range device:
   emulate(cpuThrottlingRate=4, networkConditions="Slow 4G")
   performance_start_trace(reload=true, autoStop=true)
   emulate()  // reset

4. Add web-vitals to production build for real INP distribution
```

### Phase 2: Interaction Profiling (45 min)

For each of these user flows, record a performance trace + React DevTools profile:

1. **Initial page load** → note LCP element, any render-blocking tasks
2. **Sort a DataGrid column** → look for tasks > 50ms; check if server-side sort needed
3. **Apply a filter** → same
4. **Change a date range** → chart re-render cost
5. **Scroll through DataGrid** → should stay ~60fps; virtualization check

```
# Per interaction (chrome-devtools-mcp):
performance_start_trace(reload=false, autoStop=false)
click(uid="<column-header>")
wait_for(text=["sorted"])
performance_stop_trace(filePath="sort-interaction.json.gz")
# Open in chrome://tracing or Perfetto UI for flame chart
```

### Phase 3: Re-render Audit (30 min)

```
1. Start react-scan (already in dev build)
2. Perform each user flow — watch for unexpected orange/red flashes
3. For any suspicious component: add .whyDidYouRender = true
4. Identify: inline object props, unstable context values, missing memo
5. React DevTools Profiler → "Record" → perform flow → check actualDuration vs baseDuration
```

### Phase 4: Memory Audit (20 min)

```
# chrome-devtools-mcp (requires --experimentalMemory=true):
1. take_heapsnapshot(filePath="baseline.heapsnapshot")
2. Open and close 5 different widgets / navigate 5 pages
3. evaluate_script(function="() => window.gc && window.gc()")
4. take_heapsnapshot(filePath="after-nav.heapsnapshot")
5. get_heapsnapshot_summary(filePath="after-nav.heapsnapshot")
   → Look for growing Detached DOM Tree, growing listener counts
```

### Phase 5: Bundle Analysis (15 min)

```bash
vite build
npx vite-bundle-visualizer -t treemap  # find largest modules
npx vite-bundle-visualizer -t network  # find accidental full imports

# lighthouse MCP:
find_unused_javascript(url="http://localhost:3000")
```

### Phase 6: Fix, Verify, Repeat

```
1. Apply fixes in order: INP impact first (sort/filter interactions)
2. Re-run interaction traces → compare TBT and long task durations
3. Check React Profiler: actualDuration should decrease
4. For bundle changes: rebuild, run visualizer, compare sizes
5. Update web-vitals RUM → monitor INP distribution over 1 week
```

---

## 10. All Tools — Quick Reference

| Tool                                    | Category              | Install                                                   | Dev-only?           | Cost                  |
| --------------------------------------- | --------------------- | --------------------------------------------------------- | ------------------- | --------------------- |
| `chrome-devtools-mcp`                   | MCP (existing)        | Already installed                                         | No (lab tool)       | Free                  |
| `@danielsogl/lighthouse-mcp`            | MCP (add)             | MCP config npx                                            | No (lab tool)       | Free                  |
| `@playwright/mcp`                       | MCP (add)             | MCP config npx                                            | No (lab tool)       | Free                  |
| `cdp-extended-mcp`                      | MCP (add)             | MCP config npx                                            | No (lab tool)       | Free (evaluate first) |
| `react-scan`                            | Dev overlay           | `npm i -D react-scan` (0.5.6)                             | Yes                 | Free                  |
| `@welldone-software/why-did-you-render` | Re-render diagnosis   | `npm i -D @welldone-software/why-did-you-render` (10.0.1) | **Strictly yes**    | Free                  |
| React DevTools (browser ext)            | Profiler + components | Chrome Web Store                                          | No (DevTools)       | Free                  |
| `rollup-plugin-visualizer`              | Bundle analysis       | `npm i -D rollup-plugin-visualizer` (7.0.1)               | Build-time          | Free                  |
| `source-map-explorer`                   | Bundle analysis       | `npm i -D source-map-explorer` (2.5.3)                    | Build-time          | Free                  |
| `web-vitals`                            | RUM                   | `npm i web-vitals` (5.2.0)                                | **No — production** | Free                  |

**MCP tools require no project install** — they run via `npx` in the MCP server config.

---

## Confidence Assessment

| Finding                                                                | Confidence | Basis                                                 |
| ---------------------------------------------------------------------- | ---------- | ----------------------------------------------------- |
| chrome-devtools-mcp tool list (45 tools, perf/heap/network/lighthouse) | **High**   | GitHub source files read directly[^2][^3][^4]         |
| `lighthouse_audit` excludes performance score                          | **High**   | Explicit note in tool description[^5]                 |
| `@danielsogl/lighthouse-mcp` 13 tools                                  | **High**   | README + source files read[^6]                        |
| INP replaced FID in March 2024                                         | **High**   | web.dev authoritative source[^1]                      |
| MUI sx prop ~3× slower than div                                        | **High**   | Official MUI benchmark numbers[^20]                   |
| DataGrid 100k row sort = 563ms                                         | **Medium** | Issue #2175, v4 era benchmarks[^18]                   |
| `cdp-extended-mcp` fills chrome-devtools gaps                          | **Medium** | 0 stars, new tool — not battle-tested[^8]             |
| react-scan v0.5.6                                                      | **High**   | npm registry confirmed[^9]                            |
| Studio selector patterns                                               | **High**   | Source code read directly[^23]                        |
| CSS coverage via cdp-extended-mcp                                      | **Medium** | Tool documented; Emotion/MUI interaction not verified |

---

## Footnotes

[^1]: [web.dev/articles/inp](https://web.dev/articles/inp) — INP metric definition; replaced FID in Core Web Vitals March 2024

[^2]: [ChromeDevTools/chrome-devtools-mcp:README.md](https://github.com/ChromeDevTools/chrome-devtools-mcp) — Official Google MCP server, 45 tools, Apache-2.0, npm `chrome-devtools-mcp@1.0.1`

[^3]: [ChromeDevTools/chrome-devtools-mcp:src/tools/performance.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/performance.ts) — CDP trace categories used by `performance_start_trace`

[^4]: [ChromeDevTools/chrome-devtools-mcp:src/tools/memory.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/memory.ts) — Heap snapshot tools, require `--experimentalMemory=true`

[^5]: [ChromeDevTools/chrome-devtools-mcp:src/tools/lighthouse.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/lighthouse.ts) — Lighthouse excludes performance; accessibility/SEO/best-practices only

[^6]: [danielsogl/lighthouse-mcp-server:README.md](https://github.com/danielsogl/lighthouse-mcp-server) — 13 tools, `@danielsogl/lighthouse-mcp@latest`, Node ≥ 22, TypeScript

[^7]: [microsoft/playwright-mcp:README.md](https://github.com/microsoft/playwright-mcp) — `@playwright/mcp@latest`, 32,827 stars, `--caps=devtools,network` for performance tools

[^8]: [MahyarNemati/cdp-extended-mcp:README.md](https://github.com/MahyarNemati/cdp-extended-mcp) — 38 tools across 5 CDP domains missing from chrome-devtools-mcp; 0 stars, new

[^9]: [aidenybai/react-scan:README.md](https://github.com/aidenybai/react-scan) — `react-scan@0.5.6`, `npx -y react-scan@latest init` for auto-setup

[^10]: [welldone-software/why-did-you-render:README.md](https://github.com/welldone-software/why-did-you-render) — `@welldone-software/why-did-you-render@10.0.1`; not compatible with React Compiler

[^11]: [react.dev/reference/react/Profiler](https://react.dev/reference/react/Profiler) — `<Profiler>` component, `onRender` callback parameters

[^12]: [btd/rollup-plugin-visualizer:README.md](https://github.com/btd/rollup-plugin-visualizer) — `rollup-plugin-visualizer@7.0.1`, Node ≥ 22

[^13]: [danvk/source-map-explorer:README.md](https://github.com/danvk/source-map-explorer) — `source-map-explorer@2.5.3`, works post-build on any `.js` + `.js.map` pair

[^14]: [GoogleChrome/web-vitals:README.md](https://github.com/GoogleChrome/web-vitals) — `web-vitals@5.2.0`, ~2KB brotli, `web-vitals/attribution` for INP/LCP/CLS root cause

[^15]: [web.dev/articles/optimize-inp](https://web.dev/articles/optimize-inp) — `scheduler.yield()` pattern, `rAF + setTimeout` fallback

[^16]: mui/mui-x:packages/x-data-grid/src/constants/dataGridPropsDefaultValues.ts — `columnBufferPx: 150`, `rowBufferPx: 150`, `rowHeight: 52`, `resizeThrottleMs: 60`

[^17]: mui/mui-x:packages/x-data-grid/src/models/props/DataGridProps.ts — `disableVirtualization`, `virtualizeColumnsWithAutoRowHeight`, `virtualizerLayoutMode`

[^18]: mui/mui-x:issues/2175 — DataGrid sort/filter benchmarks at 100, 10k, 100k rows

[^19]: mui/mui-x:docs/data/data-grid/performance/performance.md — Memoization requirements for `columns`, `slots`, `cellModesModel`, callback props

[^20]: [mui.com/system/getting-started/usage/#performance-tradeoffs](https://mui.com/system/getting-started/usage/) — Official benchmark: `Box sx={}` ~3× slower than `div className`

[^21]: mui/mui-x:packages/x-charts/src/ScatterChart/BatchScatter.tsx — `BatchScatter` batches 1000 points per SVG `<path>`; `pointerEvents: none` optimization; imperative animation updates bypass React

[^22]: mui/mui-x:issues/18015 — Canvas rendering tracked as future enhancement; SVG-only currently

[^23]: mui/mui-x:packages/x-studio/src/context/selectors.ts — Module-level selectors, closure-based array memoization, `selectPartitionedFilters` O(N×F) → O(F) optimization
