/**
 * Viewport width below which edit mode falls back to the tabbed sidebar.
 *
 * A literal string rather than a `theme.breakpoints.down('md')` call, matching how the pickers and
 * charts declare their media queries: the component then needs no theme at all, so it behaves
 * identically whether or not a `ThemeProvider` is present. `900px` is the default `md` breakpoint;
 * a host that has moved its breakpoints — or simply wants a different threshold — passes its own
 * query through `Studio`'s `narrowLayoutMediaQuery` prop.
 *
 * Kept in its own module rather than in `StudioContent`, so reading the default does not pull in
 * the canvas, every drawer and the chart packages.
 */
export const DEFAULT_NARROW_LAYOUT_MEDIA_QUERY = '@media (max-width: 899.95px)';
