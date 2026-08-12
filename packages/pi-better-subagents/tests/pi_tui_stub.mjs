/** Stub of the public pi-tui surface used by extension-level tests. */
export const Key = {
    left: "left",
    x: "x",
    X: "X",
    up: "up",
    down: "down",
    enter: "enter",
    escape: "escape",
};
export function matchesKey(data, key) {
    if (data == null || key == null) return false;
    if (data === key) return true;
    if (data === `<${key}>`) return true;
    return false;
}
export function truncateToWidth(s, w) {
    const str = String(s ?? "");
    const width = Number(w) || 0;
    return str.length > width ? str.slice(0, Math.max(0, width)) : str;
}

export class Container {
    constructor() { this.children = []; }
    addChild(child) { this.children.push(child); }
    render(width) { return this.children.flatMap((child) => child.render(width)); }
    invalidate() { for (const child of this.children) child.invalidate?.(); }
}
