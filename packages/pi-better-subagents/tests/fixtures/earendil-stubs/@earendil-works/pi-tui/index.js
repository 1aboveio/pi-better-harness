export const Key = {
    Enter: 'enter',
    Escape: 'escape',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

export function matchesKey(input, key) {
    return input === key || input?.name === key || input?.key === key;
}

export function truncateToWidth(value, width) {
    const text = String(value ?? '');
    if (!Number.isFinite(width) || width < 0) return text;
    return text.length <= width ? text : text.slice(0, width);
}
