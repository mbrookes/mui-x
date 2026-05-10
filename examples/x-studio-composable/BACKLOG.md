XSC-BL-01: Clicking or dragging and dropping a widget should not open the config dialog.

~~XSC-BL-02: Edit dialogs need padding around the content~~ **Fixed** (DialogContent now has `p: 1.5` to match the DrawerPanel scroll-area padding)

~~XSC-BL-03: Edit dialogs need cancel/submit buttons~~ **Fixed** (DialogActions "Done" button closes and deselects; since changes are applied reactively, Cmd+Z undoes them if needed)

~~XSC-BL-04: Tabs for setup and formatting are missing from the config dialog~~ **Fixed** (DrawerSubheaderContext provided at dialog level; WidgetConfigView injects Setup/Format tabs via useDrawerSubheader, captured and rendered between DialogTitle and DialogContent)
