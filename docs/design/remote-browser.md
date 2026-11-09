# Remote Session Browser

## Scope

Native `/remote` landing page and new-session folder picker in `pi-better-server`.
Mode: Operate. The user chose prototype A, the grouped session list, after
comparing the grouped list, folder rail, and command-first prototypes.

## Direction Contract

**Thesis:** Put existing sessions first, grouped by their complete working folder.
New-session creation starts with an explicit remote folder choice rather than
silently using the host's workspace root.

**Own-world:** Inherit Pi's terminal theme, semantic colors, monospace cell grid,
selection marker, and keyboard navigation. Folder headings separate groups;
session names and activity labels form aligned rows. Do not introduce a web shell,
cards, fixed colors, or a competing design system.

**Story:** Connecting reaches the landing page even when local history exists.
Users attach to existing sessions or choose New Session, browse a remote folder,
and select it. Creating a folder opens that folder; starting a session remains
an explicit action. Move and Copy are opt-in landing-page actions.

**First Viewport:** Host identity, Active and Closed tabs, grouped session rows,
selected-session detail when space permits, and a keyboard action footer.
Folder headings use full paths, shortened only to fit the terminal. Small
terminals prioritize the selected row and actions over secondary context.

**Form:** User-selected prototype A. No new palette or visual identity is being
introduced. The signature interaction is a focused folder picker that returns
to the same session selection when cancelled.

**Progress:** Use Pi's native loader for connection stages, browser loading,
directory listing, folder creation, package checks and installation, and opening
or starting a session. Read waits can be dismissed. Unabortable writes must not
claim cancellation; keep progress visible until their result is known.

**Finish:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
This extends the existing terminal interface and ships no raster assets.

## Verification

- Independent review identified three fixes: cancellable package reads, short
  terminal footer budgeting, and progress during the transfer connection. The
  follow-up reviewer scored all three resolved.
- The package verification command passed in a clean checkout containing only
  this change: TypeScript passed, 519 tests passed, 8 skipped, and no failures.
  Unrelated startup-upgrade edits in the shared workspace were excluded.
- A real Pi process rendered the production browser components through
  `ctx.ui.custom` at 100x30 and 32x12. Keyboard navigation, both tabs, folder
  navigation, retained selection after Escape, action footers, and pending-read
  progress passed. Remote data was mocked; no live SSH or remote mutations were
  performed in that smoke. Real local daemon tests cover folder creation and
  transfer ownership behavior separately.
- This is native terminal verification, not browser-screenshot approval. The
  interface continues to inherit Pi's theme as recorded in the package DESIGN.md.