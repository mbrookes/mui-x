---
title: Studio — Data lineage
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio — Data lineage

<p class="description">A data-lineage graph in the data drawer shows sources as nodes and declared relationships as directed edges.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

When `StudioDataDrawer` has at least two visible data sources, it shows a **View data lineage** action.
Clicking it opens a dialog that renders the internal `DataLineageGraph` component automatically.

In composed apps that use `StudioDataDrawer` directly, no extra setup is required.

## What the graph shows

Source nodes are drawn as rounded rectangles in a simple grid layout.
Relationship edges are rendered as SVG cubic Bézier curves with directional arrowheads.
Each edge gets a badge showing cardinality:

- `N:1` for `many-to-one`
- `1:1` for `one-to-one`
- `N:M` for `many-to-many`

## Inspecting an edge

Click an edge label to open a popover with the relationship details:

- source and target source names
- relationship type
- join key fields
- junction source for `many-to-many` relationships

The graph filters out hidden sources, and the dialog scrolls horizontally if the SVG is wider than the drawer.

## Automatic rendering

`DataLineageGraph` is an internal component.
You normally do not mount it yourself.
`StudioDataDrawer` renders it for you when the dashboard has enough visible sources to show lineage.

## See also

- [Relationships](/x/react-studio/data/relationships/) — declare the edges shown in the lineage graph
- [Inline data sources](/x/react-studio/data/data-sources/) — define the source nodes
