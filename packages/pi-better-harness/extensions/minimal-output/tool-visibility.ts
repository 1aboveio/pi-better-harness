interface Rect { x: number; y: number; width: number; height: number }
interface LegacyComponent {
  mouseLayout?: { children: { component: LegacyComponent; height: number }[] };
  paddingX?: number;
  paddingY?: number;
}
interface LayoutBox {
  component: LegacyComponent;
  rect: Rect;
  clip: Rect;
  children: LayoutBox[];
  lineOffset?: number;
}
export interface ViewportUI { mode?: string; currentLayout?: { root: LayoutBox }; hasOverlay?(): boolean; hasActiveSelection?(): boolean }
const frames = new WeakMap<ViewportUI, { root: LayoutBox; known: Set<object>; visible: Set<object> }>();

function intersects(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// The guarded fullscreen adapter uses the last painted layout, never calls render()
// to measure visibility, and leaves scrollback hosts on static state colors.
export function toolVisibility(ui: ViewportUI, component: object): boolean | undefined {
  if (ui.mode !== "fullscreen" || ui.hasOverlay?.() || ui.hasActiveSelection?.()) return false;
  const root = ui.currentLayout?.root;
  if (!root) return undefined;
  if (!root.rect || !root.clip || !Array.isArray(root.children)) return false;
  let frame = frames.get(ui);
  if (frame?.root !== root) {
    frame = { root, known: new Set(), visible: new Set() };
    const current = frame;
    const legacy = (child: LegacyComponent, rect: Rect, clip: Rect) => {
      if (!child || typeof child !== "object") return;
      current.known.add(child);
      if (!intersects(rect, clip)) return;
      current.visible.add(child);
      const children = child.mouseLayout?.children;
      if (!children) return;
      const paddingY = child.paddingY ?? 0;
      const paddingX = child.paddingX ?? 0;
      if (children.reduce((height, entry) => height + entry.height, 0) + paddingY * 2 !== rect.height) return;
      let y = rect.y + paddingY;
      for (const entry of children) {
        legacy(entry.component, { x: rect.x + paddingX, y, width: Math.max(0, rect.width - paddingX * 2), height: entry.height }, clip);
        y += entry.height;
      }
    };
    const visit = (box: LayoutBox) => {
      if (!box?.component || !box.rect || !box.clip || !Array.isArray(box.children)) return;
      current.known.add(box.component);
      if (!intersects(box.rect, box.clip)) return;
      current.visible.add(box.component);
      if (box.children.length) for (const child of box.children) visit(child);
      else legacy(box.component, { ...box.rect, y: box.rect.y - (box.lineOffset ?? 0) }, box.clip);
    };
    visit(root);
    frames.set(ui, frame);
  }
  return frame.known.has(component) ? frame.visible.has(component) : undefined;
}
