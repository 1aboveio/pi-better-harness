/**
 * Render the real Subagent settings page for the #664 evidence folder.
 *
 * Run from the repo root:
 *   node --import tsx scripts/render-subagent-skill-settings-evidence.mjs
 *
 * The theme is the identity theme so the text files stay readable. The page,
 * row model, input handling, and persistence handlers are the shipping ones;
 * only the surrounding config is a fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubagentSettingsPage } from "../packages/pi-better-subagents/settings-page.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const output = join(root, "packages", "pi-better-subagents", "docs", "evidence", "664-skill-settings-tui");
mkdirSync(output, { recursive: true });

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const paths = [
    "/Users/someone/.pi/agent/skills/better-review/SKILL.md",
    "/Users/someone/.pi/agent/skills/test-quality/SKILL.md",
];

const discovered = [
    { name: "better-review", description: "Review the change before handoff.", path: paths[0], baseDir: "/Users/someone/.pi/agent/skills/better-review" },
    { name: "test-quality", description: "Write tests that catch real bugs.", path: paths[1], baseDir: "/Users/someone/.pi/agent/skills/test-quality" },
];

function harness({ skillsMode, skillsPaths, skillsSource = "config" } = {}) {
    const saved = { mode: skillsMode, paths: [...skillsPaths], source: skillsSource };
    let current = {
        mode: "adaptive", maxConcurrent: 6, maxMinutes: 60, modeSource: "config", capSource: "config",
        defaultMode: "adaptive", defaultCap: 6,
        toolWaitMinutes: 5, stuckMinutes: 10, toolWaitSource: "default", stuckSource: "default",
        defaultToolWaitMinutes: 5, defaultStuckMinutes: 10,
        skillsMode, skillsPaths: [...skillsPaths], skillsSource,
    };
    const handlers = {
        get: () => current,
        changeMode(mode) { current = { ...current, mode, modeSource: "session" }; },
        changeCap(maxConcurrent) { current = { ...current, maxConcurrent, capSource: "session" }; },
        changeSkills(mode, next) {
            current = { ...current, skillsMode: mode, skillsPaths: [...next], skillsSource: "session" };
        },
        save() {
            saved.mode = current.skillsMode;
            saved.paths = [...current.skillsPaths];
            saved.source = "config";
            current = { ...current, skillsSource: "config" };
            return { ok: true, message: "Subagent defaults saved." };
        },
        reset() {
            current = {
                ...current, skillsMode: saved.mode, skillsPaths: [...saved.paths], skillsSource: saved.source,
            };
        },
        discoverSkills: () => discovered,
        openAgents() {},
    };
    const page = createSubagentSettingsPage(theme, handlers, () => {}, () => {});
    page.focused = true;
    return { page, current: () => current };
}

function write(name, state, width, lines) {
    writeFileSync(join(output, name), [
        `# ${state}`,
        `# width: ${width}`,
        "",
        ...lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "")),
    ].join("\n") + "\n");
}

function openPicker(h) {
    for (let attempt = 0; attempt < 32; attempt++) h.page.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 32; attempt++) {
        const text = selectedRow(h.page);
        if (text === "Selected skills" || text.startsWith("Selected skills ")) break;
        h.page.handleInput("\x1b[B");
    }
    h.page.handleInput("\r");
    return h.page;
}

function selectedRow(page) {
    return page.render(160).find((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimStart().startsWith("> "))
        ?.replace(/\x1b\[[0-9;]*m/g, "").trimStart().slice(2).trim() ?? "";
}

for (const width of [100, 60, 40, 20]) {
    const discovery = harness({ skillsMode: "inherit", skillsPaths: [], skillsSource: "default" });
    write(`discovery-${width}.txt`, "Discover automatically · no saved default", width, discovery.page.render(width));

    const none = harness({ skillsMode: "none", skillsPaths: [] });
    write(`none-${width}.txt`, "No skill catalog · saved config", width, none.page.render(width));

    const selected = harness({ skillsMode: "explicit", skillsPaths: paths });
    write(`selected-${width}.txt`, "Selected skills · saved config", width, selected.page.render(width));

    const picker = harness({ skillsMode: "explicit", skillsPaths: paths });
    openPicker(picker);
    write(`skill-checkbox-${width}.txt`, "Checkbox picker · discovered skills and checked saved paths", width, picker.page.render(width));

    const filtered = harness({ skillsMode: "explicit", skillsPaths: paths });
    openPicker(filtered);
    filtered.page.handleInput("test");
    write(`skill-checkbox-filtered-${width}.txt`, "Checkbox picker filtered to test-quality; the hidden better-review stays checked", width, filtered.page.render(width));

    const unavailable = harness({ skillsMode: "explicit", skillsPaths: ["/Users/someone/.pi/agent/skills/legacy, archived/SKILL.md"] });
    openPicker(unavailable);
    write(`skill-checkbox-unavailable-${width}.txt`, "A saved path missing from discovery stays visible as unavailable", width, unavailable.page.render(width));

    const adding = harness({ skillsMode: "inherit", skillsPaths: [] });
    openPicker(adding);
    for (let index = 0; index < 12 && !selectedRow(adding.page).includes("Add skill path"); index++) adding.page.handleInput("\x1b[B");
    adding.page.handleInput("\r");
    write(`skill-add-path-${width}.txt`, "Manual Add skill path remains available", width, adding.page.render(width));

    const zero = harness({ skillsMode: "inherit", skillsPaths: [] });
    openPicker(zero);
    zero.page.handleInput("\r");
    write(`skill-zero-${width}.txt`, "Zero checked applies No skill catalog and returns to the settings page", width, zero.page.render(width));
}

writeFileSync(join(output, "TRANSCRIPT.md"), `# Subagent skill settings evidence

Generated by:

\`\`\`sh
node --import tsx scripts/render-subagent-skill-settings-evidence.mjs
\`\`\`

The component is \`packages/pi-better-subagents/settings-page.ts\` with the same
theme, row model, input handling, and handlers used by \`/subagents settings\`
and the \`/harness-settings\` Subagents link. The runtime persistence and launch
proof lives in \`packages/pi-better-subagents/tests/skill-settings-tui.test.mjs\`.

## Keyboard script

1. \`Up/Down\` moves between rows.
2. \`Space\` or \`Enter\` on Skill exposure cycles Discover automatically and
   No skill catalog. Selected skills is a separate row that opens the shared
   checkbox picker.
3. In the picker, \`Up/Down\` moves, \`Space\` toggles a skill, typing filters,
   \`Enter\` applies, and \`Esc\` cancels without changing the list.
4. \`Enter\` on Add skill path opens the manual path input. An empty, relative,
   duplicate, or missing path stays in the editor with a message.
5. Zero checked applies No skill catalog. It never means discovery and never
   leaves an invalid empty Selected skills draft.
6. \`Ctrl+S\` saves mode, cap, and skill exposure together.
7. Reset to defaults restores the saved mode, cap, and skill exposure.
8. \`Esc\` closes the page.
`);

console.log(`wrote ${output}`);
