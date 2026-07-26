/**
 * Stub of `@earendil-works/pi-tui` for extension-level tests.
 * Navigator glue uses Key / matchesKey / truncateToWidth only.
 */
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
