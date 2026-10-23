# Native Remote Browser

This surface extends the compact, keyboard-first terminal identity in the root
`PRODUCT.md`. It does not introduce a new web interface or fixed color palette.
The approved composition is prototype A, the grouped session list. Its scope and
interaction decisions are recorded in `../../docs/design/remote-browser.md`.

## Layout

- Show the remote host, starting folder, Active and Closed tabs, grouped sessions,
  optional selected-session detail, and action legend in that order.
- Group by the complete working-directory string. Paths are headings, not repeated
  basename columns. Keep names and activity labels aligned with terminal-column
  width helpers; folder headings are not selectable session rows.
- Preserve session selection by ID through refresh and folder-picker cancellation.
- Reserve three terminal lines for Pi's footer. At short heights, drop secondary
  details and spacing before losing the selected row or keyboard actions.
- The folder picker is a separate focused screen with current path, parent and
  child directories, errors when present, and a keyboard legend.

## Theme Tokens

Use Pi's active `Theme` rather than hardcoded terminal colors or backgrounds:

| Token | Role |
| --- | --- |
| `accent` | Selected row, active tab, current folder, loader |
| `muted` | Folder headings, idle and closed state, secondary context |
| `warning` | Input needed, moved or fenced ownership |
| `error` | Operation failures with a retry or navigation action |
| `dim` | Action legend, short session ID, scroll position |
| `bold` | Host heading and active tab |

State also uses text labels and a `>` selection marker, never color alone.
Sanitize remote text before rendering; truncate by visible terminal columns.

## Progress And Safety

After connection, a screen-only browse scope unmounts the surrounding local
transcript, startup header and widgets. It mounts Pi's existing editor and live
footer containers so native progress, confirmations and custom screens keep
working, with navigator hints and extension status visible below the home page.
Fullscreen browsing uses Pi's native vertical layout to pin the footer at the
bottom while the browser occupies the remaining height.
Cancellation and failure restore the original mounts without replacing the local
runtime or changing its history. Remote attachment hides the local startup header
until disconnect.

Host-level extension checks and approved updates finish before opening the
session browser. Deferred-update notices are rendered inside the browser rather
than sent only to its hidden local notification area. Unsupported local resources
are deduplicated and summarized. Legacy and busy refusals do not close sessions.

Use native Pi loaders, without invented percentages, for remote waits. The SSH
loader names each connection stage. Browser and folder reads can be dismissed;
late replies cannot complete a disposed screen. Unabortable writes remain visible
until settled. No input or confirmation dialog nests inside a custom-screen
factory. Move and Copy require explicit intent, destination and transfer scope.

The terminal inherits the user's font, size and theme. There are no shipping
raster assets, decorative animation, or standalone browser design tokens.