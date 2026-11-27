import type { Component } from "@earendil-works/pi-tui";
import type { WorkflowFrame } from "./workflow-view.js";

// Structural typing keeps keyboard-only Pi versions compatible with the fullscreen mouse API.
interface PlanMouseEvent {
  type: string;
  button: string;
  x: number;
  y: number;
  width: number;
  screenX?: number;
  screenY?: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

interface PlanMouseResult {
  handled: true;
  render: boolean;
  capture?: boolean;
  target?: { component: Component; originX: number; originY: number; width: number; height: number };
}

export function createPlanWidget(
  render: (width: number, disclosure?: string, previewShare?: number) => string[],
  isFoldable: () => boolean,
  isExpanded: () => boolean,
  toggle: () => void,
  actionAt?: (x: number, y: number) => (() => void) | undefined,
  divider?: { resizeAt: WorkflowFrame["resizeAt"]; save(share: number): void },
): Component & { handleMouse(event: PlanMouseEvent): PlanMouseResult | undefined } {
  let lines: string[] = [];
  let drag: { start: number; width: number; shareAt(x: number): number; preview?: number } | undefined;
  return {
    render(width) {
      if (drag && drag.width !== width) drag = undefined;
      lines = render(width, isFoldable() ? isExpanded() ? "▾" : "▸" : undefined, drag?.preview);
      return lines.length ? ["", ...lines] : [];
    },
    handleMouse(event) {
      if (drag && (event.type === "drag" || event.type === "release")) {
        const share = event.x === drag.start ? undefined : drag.shareAt(event.x);
        const changed = share !== drag.preview;
        drag.preview = share;
        if (event.type === "release") {
          drag = undefined;
          if (share !== undefined) divider?.save(share);
        }
        return { handled: true, render: changed };
      }
      if ((event.type !== "click" && event.type !== "press") || event.button !== "left" || event.shift || event.alt || event.ctrl ||
          event.x < 0 || event.x >= event.width || event.y < 1 || event.y > lines.length) return undefined;
      const shareAt = divider?.resizeAt(event.x, event.y - 1);
      if (shareAt) {
        if (event.type === "click") return { handled: true, render: false };
        drag = { start: event.x, width: event.width, shareAt };
        // Capture this widget with its local origin inside the composite navigator panel.
        if (event.screenX === undefined || event.screenY === undefined) return { handled: true, capture: true, render: false };
        return {
          handled: true, render: false, capture: true,
          target: {
            component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
            width: event.width, height: lines.length + 1,
          },
        };
      }
      const action = actionAt?.(event.x, event.y - 1) ?? (isFoldable() ? toggle : undefined);
      if (!action) return undefined;
      // Pi synthesizes click only for a component that handled the initial press.
      if (event.type === "press") return { handled: true, render: false };
      action();
      return { handled: true, render: true };
    },
    invalidate() { lines = []; drag = undefined; },
  };
}