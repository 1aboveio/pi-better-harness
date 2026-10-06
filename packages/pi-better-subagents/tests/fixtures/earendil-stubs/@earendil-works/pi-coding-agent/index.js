/** Minimal runtime stub for loading index.ts without the host pi install. */
import { tmpdir } from "node:os";
import { join } from "node:path";

export function getAgentDir() {
    return process.env.PI_CODING_AGENT_DIR || join(tmpdir(), "pi-test-agent");
}

export class CustomEditor {
    constructor(tui, theme, keybindings) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
    }
}
