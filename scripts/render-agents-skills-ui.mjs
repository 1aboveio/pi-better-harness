/**
 * Render the real `/agents` skill-configuration screens to text and SVG.
 *
 * The component, catalog loader, and definition save path are the production
 * ones. Only the host is a fixture: a bundled role, two personal named agents,
 * and the global `defaultSkills` test seam. Run from the repo root:
 *
 *   node --import tsx scripts/render-agents-skills-ui.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { executeAgentsCommand } from "../packages/pi-better-subagents/agent-commands.ts";
import { setConfigForTests } from "../packages/pi-better-subagents/config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "packages/pi-better-subagents/docs/evidence/664-skill-catalog-tui");
const ROLE_SKILL = "/Users/exoulster/.agents/skills/review/SKILL.md";
const GLOBAL_SKILL = "/Users/exoulster/.agents/skills/test-quality/SKILL.md";

const theme = {
    fg: (color, text) => `\x1b[${color === "accent" ? "36" : color === "muted" ? "90" : color === "dim" ? "2" : color === "error" ? "31" : color === "warning" ? "33" : "0"}m${text}\x1b[0m`,
    bg: (_color, text) => `\x1b[7m${text}\x1b[27m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    inverse: (text) => `\x1b[7m${text}\x1b[27m`,
};

const root = mkdtempSync(join(tmpdir(), "catalog-skills-artifact-"));
const loc = { cwd: join(root, "project"), userRoot: join(root, "user"), bundledRoot: join(root, "bundled"), projectTrusted: true };
mkdirSync(loc.cwd, { recursive: true });
mkdirSync(loc.bundledRoot, { recursive: true });
mkdirSync(join(loc.userRoot, "agents", "agents"), { recursive: true });
writeFileSync(join(loc.bundledRoot, "role.work.md"), `---
schema: pi-agent/v1
kind: role
id: role.work
name: Developer
description: Implements a requested change and owns focused tests.
defaults:
  model: openai/gpt-6.1-sol
  effort: high
  tier: balanced
  skills:
    - ${ROLE_SKILL}
---
Implement the requested change. Review the diff before handoff.
`);
writeFileSync(join(loc.bundledRoot, "role.review.md"), `---
schema: pi-agent/v1
kind: role
id: role.review
name: Reviewer
description: Reviews a change without editing it.
defaults:
  model: openai/gpt-6-astra
  effort: medium
  tier: frontier
---
Review the change.
`);
const agents = {
    "agent.worker.md": `---
schema: pi-agent/v1
kind: agent
id: agent.worker
name: Payments Developer
roleId: role.work
instructions:
  mode: add
---
Check payment edge cases before editing.
`,
    "agent.auditor.md": `---
schema: pi-agent/v1
kind: agent
id: agent.auditor
name: Release Auditor
roleId: role.review
instructions:
  mode: add
---
Audit release metadata.
`,
};
for (const [name, markdown] of Object.entries(agents)) writeFileSync(join(loc.userRoot, "agents", "agents", name), markdown);
setConfigForTests({ defaultSkills: [GLOBAL_SKILL] });

let component;
const ui = {
    notify() {},
    async custom(factory) { component = factory({ requestRender() {} }, theme, {}, () => {}); },
};
const host = { cwd: loc.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true, ui };
const deps = {
    ...loc,
    sessionSettings: { snapshot: () => ({}), change() {}, reset() {} },
};
const open = async (id) => {
    await executeAgentsCommand(`show ${id}`, host, deps);
    return component;
};
const render = (width) => component.render(width);
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const screens = [];
function capture(name, width, note = "") {
    const lines = render(width);
    while (lines.length > 0 && plain(lines[lines.length - 1]).trim() === "") lines.pop();
    screens.push({ name, width, note, lines });
    writeFileSync(join(OUT, `${name}.txt`), `${note ? `${note}\n\n` : ""}${lines.map(plain).join("\n")}\n`);
}

mkdirSync(OUT, { recursive: true });

// 1. An agent inheriting the base role's skill list.
const worker = await open("agent.worker");
capture("agent-detail-role-inheritance-100", 100, "agent.worker inherits role.work defaults.skills; no agent override exists.");

// 2. The skill picker, starting on the definition's own choice (Inherit).
worker.handleInput("\x1b[B"); worker.render(100);
worker.handleInput("\x1b[B"); worker.render(100);
worker.handleInput("\r");
capture("agent-skills-picker-100", 100, "Picker opens on the definition's own choice. The header names the effective value and source.");

// 3. Selected paths with a relative path rejected; nothing is written.
worker.handleInput("\x1b[B"); worker.handleInput("\x1b[B"); worker.handleInput("\r");
for (const character of ".agents/skills/review/SKILL.md") worker.handleInput(character);
worker.handleInput("\r");
capture("agent-skills-relative-error-100", 100, "A relative path is refused because a definition has no workspace of its own.");

// 4. Choose none, then show the saved override and the refreshed detail.
for (let index = 0; index < ".agents/skills/review/SKILL.md".length; index++) worker.handleInput("\x7f");
worker.handleInput("\x1b");
worker.handleInput("\r");
worker.handleInput("\x1b[B");
worker.handleInput("\r");
capture("agent-detail-after-none-100", 100, "No skill catalog saves [] to overrides.skills; the picker is no longer a role inheritance.");
capture("agent-detail-after-none-42", 42, "The same saved override at 42 columns.");

// 5. A bundled role with no own list shows the global default source.
const reviewer = await open("role.review");
capture("role-detail-global-source-100", 100, "role.review has no defaults.skills; the global defaultSkills value supplies the exposure.");

// 6. An explicit null override is shown as suppression, with the fall-through source.
writeFileSync(join(loc.userRoot, "agents", "agents", "agent.auditor.md"), `---
schema: pi-agent/v1
kind: agent
id: agent.auditor
name: Release Auditor
roleId: role.review
instructions:
  mode: add
overrides:
  skills: null
---
Audit release metadata.
`);
const auditor = await open("agent.auditor");
capture("agent-detail-suppressed-100", 100, "An explicit null suppresses the role list but still falls through to the global default.");

for (const screen of screens) writeFileSync(join(OUT, `${screen.name}.svg`), svg(screen));
writeFileSync(join(OUT, "README.md"), readme());
rmSync(root, { recursive: true, force: true });
setConfigForTests(undefined);

function svg(screen) {
    const charWidth = 8.4;
    const lineHeight = 18;
    const pad = 20;
    const columns = Math.max(20, ...screen.lines.map((line) => visibleWidth(plain(line))));
    const width = Math.ceil(columns * charWidth + pad * 2);
    const height = Math.ceil((screen.lines.length + 2) * lineHeight + pad * 2);
    const rows = screen.lines.map((line, index) => {
        const y = pad + 22 + index * lineHeight;
        const spans = ansiSpans(line).map((span) => `<tspan fill="${span.fill}"${span.bold ? ' font-weight="700"' : ""}${span.inverse ? ' style="text-decoration:none"' : ""}>${escapeXml(span.text)}</tspan>`).join("");
        return `  <text x="${pad}" y="${y}" xml:space="preserve">${spans}</text>`;
    }).join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#15161a" rx="12"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#2c2d34" rx="11.5"/>
  <circle cx="${pad + 4}" cy="${pad - 4}" r="4" fill="#f87171"/>
  <circle cx="${pad + 16}" cy="${pad - 4}" r="4" fill="#fbbf24"/>
  <circle cx="${pad + 28}" cy="${pad - 4}" r="4" fill="#34d399"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13" fill="#d7d8de">
${rows}
  </g>
</svg>
`;
}

function ansiSpans(line) {
    const spans = [];
    let fill = "#d7d8de";
    let bold = false;
    let inverse = false;
    let index = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
        if (match.index > index) spans.push({ text: line.slice(index, match.index), fill, bold, inverse });
        for (const code of match[1].split(";").filter(Boolean)) {
            if (code === "0") { fill = "#d7d8de"; bold = false; inverse = false; }
            else if (code === "1") bold = true;
            else if (code === "22") bold = false;
            else if (code === "2") fill = "#6b6c75";
            else if (code === "7") inverse = true;
            else if (code === "27") inverse = false;
            else if (code === "31") fill = "#f87171";
            else if (code === "33") fill = "#fbbf24";
            else if (code === "36") fill = "#7dd3fc";
            else if (code === "90") fill = "#8b8c95";
        }
        index = match.index + match[0].length;
    }
    if (index < line.length) spans.push({ text: line.slice(index), fill, bold, inverse });
    return spans;
}

function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readme() {
    return `# /agents skill configuration screens

Rendered from the real \`createCatalogComponent\` with the production catalog
loader and definition save path. The fixture is a bundled \`role.work\` with
\`defaults.skills\`, a bundled \`role.review\` without one, a global
\`defaultSkills\` value, and personal named agents.

Reproduce from the repository root:

\`\`\`bash
node --import tsx scripts/render-agents-skills-ui.mjs
\`\`\`

Each screen is saved twice: \`.txt\` is the plain terminal text at the stated
width, and \`.svg\` is the same render with the theme colors. The txt files are
the width proof; the SVG files are for reading the result.

| File | Width | What it shows |
| --- | --- | --- |
${screens.map((screen) => `| \`${screen.name}\` | ${screen.width} | ${screen.note} |`).join("\n")}

## Real Pi captures

\`scripts/agents-skills.tui.e2e.test.mjs\` drives the same row in a real Pi TUI
through tmux: choose No skill catalog, reload, reopen, choose one absolute
skill, then restore inheritance. It also proves the saved definition and the
effective launch resolution afterwards. The \`real-pi-*.txt\` files are raw
\`tmux capture-pane\` output at 100 columns plus one 42-column render.

\`\`\`bash
node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/agents-skills.tui.e2e.test.mjs
\`\`\`
`;
}
