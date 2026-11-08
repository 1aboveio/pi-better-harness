# /agents skill configuration screens

Rendered from the real `createCatalogComponent` with the production catalog
loader and definition save path. The fixture is a bundled `role.work` with
`defaults.skills`, a bundled `role.review` without one, a global
`defaultSkills` value, and personal named agents.

Reproduce from the repository root:

```bash
node --import tsx scripts/render-agents-skills-ui.mjs
```

Each screen is saved twice: `.txt` is the plain terminal text at the stated
width, and `.svg` is the same render with the theme colors. The txt files are
the width proof; the SVG files are for reading the result.

| File | Width | What it shows |
| --- | --- | --- |
| `agent-detail-role-inheritance-100` | 100 | agent.worker inherits role.work defaults.skills; no agent override exists. |
| `agent-skills-picker-100` | 100 | Picker opens on the definition's own choice. The header names the effective value and source. |
| `agent-skills-relative-error-100` | 100 | A relative path is refused because a definition has no workspace of its own. |
| `agent-detail-after-none-100` | 100 | No skill catalog saves [] to overrides.skills; the picker is no longer a role inheritance. |
| `agent-detail-after-none-42` | 42 | The same saved override at 42 columns. |
| `role-detail-global-source-100` | 100 | role.review has no defaults.skills; the global defaultSkills value supplies the exposure. |
| `agent-detail-suppressed-100` | 100 | An explicit null suppresses the role list but still falls through to the global default. |

## Real Pi captures

`scripts/agents-skills.tui.e2e.test.mjs` drives the same row in a real Pi TUI
through tmux: choose No skill catalog, reload, reopen, choose one absolute
skill, then restore inheritance. It also proves the saved definition and the
effective launch resolution afterwards. The `real-pi-*.txt` files are raw
`tmux capture-pane` output at 100 columns plus one 42-column render.

```bash
node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/agents-skills.tui.e2e.test.mjs
```
