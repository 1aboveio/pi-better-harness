/** Stub of the public pi-coding-agent surface used by extension-level tests. */
import { tmpdir } from "node:os";
import { join } from "node:path";

export function getAgentDir() {
    return process.env.PI_CODING_AGENT_DIR || join(tmpdir(), "pi-test-agent");
}

export class CustomEditor {
    constructor() { this._text = ""; }
    getText() { return this._text; }
    setText(t) { this._text = String(t ?? ""); }
    handleInput() {}
}

export class AssistantMessageComponent {
    constructor(message) { this.message = message; }
    updateContent(message) { this.message = message; }
    render() {
        return (this.message?.content ?? []).flatMap((block) => {
            if (block.type === "thinking") return [" Thinking..."];
            return block.type === "text" ? String(block.text ?? "").split("\n").map((line) => ` ${line}`) : [];
        });
    }
    invalidate() {}
}

export class ToolExecutionComponent {
    constructor(name, _id, args) { this.name = name; this.args = args; }
    markExecutionStarted() { this.started = true; }
    setArgsComplete() {}
    updateResult() {}
    render() { return [` [${this.started ? "running" : "queued"}] ${this.name} ${JSON.stringify(this.args ?? {})}`]; }
    invalidate() {}
}

export function getMarkdownTheme() { return {}; }
