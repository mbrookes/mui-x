~~XSC-BL-01: Clicking or dragging and dropping a widget should not open the config dialog~~ **Fixed** (ComposeDialog is now prop-controlled like DataDialog/FiltersDialog; clicking a widget or DnD repositioning it only selects it without opening the dialog; the dialog is explicitly opened via the toolbar configure button (TuneIcon) or automatically after adding a new widget via AddWidgetFab)

~~XSC-BL-02: Edit dialogs need padding around the content~~ **Fixed** (DialogContent now has `p: 1.5` to match the DrawerPanel scroll-area padding)

~~XSC-BL-03: Edit dialogs need cancel/submit buttons~~ **Fixed** (DialogActions "Done" button closes and deselects; since changes are applied reactively, Cmd+Z undoes them if needed)

~~XSC-BL-04: Tabs for setup and formatting are missing from the config dialog~~ **Fixed** (DrawerSubheaderContext provided at dialog level; WidgetConfigView injects Setup/Format tabs via useDrawerSubheader, captured and rendered between DialogTitle and DialogContent)
