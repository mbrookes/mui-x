---
title: Studio - Text widget
description: The text widget places a static or templated text block on the canvas with configurable typography, alignment, and optional Markdown rendering.
---

# Studio - Text widget

<p class="description">The text widget places a static or templated text block on the canvas with configurable typography, alignment, and optional Markdown rendering.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioTextWidget` renders freeform text content on the dashboard canvas. It supports
three semantic variants — title, subtitle, and body — each with its own typography
defaults, plus optional inline Markdown for rich content.

## Configuration

```ts
interface StudioTextConfig {
  content: string;
  variant: StudioTextVariant;
  align?: 'left' | 'center' | 'right';
  markdown?: boolean;  // render content as Markdown (default: false)
}

type StudioTextVariant = 'title' | 'subtitle' | 'body';
```

## Variants

| Variant | Default MUI typography | Typical use |
| :--- | :--- | :--- |
| `title` | `h5` | Page heading, widget section heading |
| `subtitle` | `subtitle1` | Descriptor line below a heading |
| `body` | `body1` | Paragraphs, annotations, context notes |

The variant controls the default `Typography` component and its corresponding
theme tokens. Override them with `slotProps.textWidget.sx` if needed.

## Basic example

```ts
const textConfig: StudioTextConfig = {
  variant: 'title',
  content: 'Sales Overview',
  align: 'left',
};
```

```ts
const textConfig: StudioTextConfig = {
  variant: 'body',
  content: 'All figures are in USD. Refresh rate: every 15 minutes.',
  align: 'center',
};
```

## Markdown

Enable Markdown rendering by setting `markdown: true`. The content string is then
parsed as CommonMark Markdown and rendered as HTML inside the widget card.

```ts
const textConfig: StudioTextConfig = {
  variant: 'body',
  markdown: true,
  content: `## Key Takeaways\n\n- Revenue is up 12 % month-over-month\n- Q4 target: **$2.4M**`,
};
```

:::info
Markdown support uses a sanitised renderer. Script tags and event attributes are
stripped to prevent XSS. Use trusted content only.
:::

## Alignment

Use `align` to control horizontal text alignment within the widget card.

```ts
const textConfig: StudioTextConfig = {
  variant: 'subtitle',
  content: 'Data as of 1 Jan 2025',
  align: 'right',
};
```

## Slot props

Customise the underlying `Typography` component via `slotProps`:

```tsx
<Studio
  slotProps={{
    textWidget: {
      sx: { fontStyle: 'italic', opacity: 0.7 },
    },
  }}
/>
```

## See also

- [Slot props](/x/react-studio/customization/slot-props/) — full slot props reference including `textWidget`
- [Theming](/x/react-studio/customization/theming/) — override `h5`, `subtitle1`, and `body1` at the theme level
- [Canvas interactions](/x/react-studio/behaviors/canvas-interactions/) — double-click a text widget in edit mode to edit content inline
