/**
 * Stub of `@earendil-works/pi-coding-agent` for extension-level tests.
 * Only CustomEditor is imported by the navigator glue in index.ts.
 */
export class CustomEditor {
    constructor() {
        this._text = "";
    }
    getText() {
        return this._text;
    }
    setText(t) {
        this._text = String(t ?? "");
    }
    handleInput() {}
}
