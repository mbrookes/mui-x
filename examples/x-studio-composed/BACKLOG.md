~~XSC-BL-01: Clicking or dragging and dropping a widget should not open the config dialog~~ **Fixed** (ComposeDialog is now prop-controlled like DataDialog/FiltersDialog; clicking a widget or DnD repositioning it only selects it without opening the dialog; the dialog is explicitly opened via the toolbar configure button (TuneIcon) or automatically after adding a new widget via AddWidgetFab)

~~XSC-BL-02: Edit dialogs need padding around the content~~ **Fixed** (DialogContent now has `p: 1.5` to match the DrawerPanel scroll-area padding)

~~XSC-BL-03: Edit dialogs need cancel/submit buttons~~ **Fixed** (DialogActions "Done" button closes and deselects; since changes are applied reactively, Cmd+Z undoes them if needed)

~~XSC-BL-04: Tabs for setup and formatting are missing from the config dialog~~ **Fixed** (DrawerSubheaderContext provided at dialog level; WidgetConfigView injects Setup/Format tabs via useDrawerSubheader, captured and rendered between DialogTitle and DialogContent)

~~XSC-BL-05: Filters panel isn't scrollable when there are more filters than fit in the dialog.~~ **Fixed** (DialogContent had `overflow: 'hidden'` preventing scroll; changed to `overflow: 'auto'`)

~~XSC-BL-06: Make the AI chat panel a full-height slideout side panel. Add a + button to the immeediate right of the tabs that adds an empty page. Hid it when there is an empty unconfigured page to prevent adding multiple empty pages. For empty pages, embed a chat dialog with an example prompt for creating the new page content.~~ **Fixed** (ChatSidePanel replaces the fixed overlay — slides in as a flex sibling with CSS width transition; + button sits right of Tabs in edit mode, hidden when any page is empty; EmptyPagePrompt (centered chat panel with AI branding) shown in canvas when the active page has no widgets)
