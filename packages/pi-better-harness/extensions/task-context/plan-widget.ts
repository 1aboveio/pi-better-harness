import type { Component } from "@earendil-works/pi-tui";


// Structural typing keeps keyboard-only Pi versions compatible with the fullscreen mouse API.
interface PlanMouseEvent {
  type: string;
  button: string;
  x: number;
  y: number;
  width: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

export function createPlanWidget(
  render: (width: number, disclosure?: string) => string[],
  isFoldable: () => boolean,
  isExpanded: () => boolean,
  toggle: () => void,
): Component & { handleMouse(event: PlanMouseEvent): { handled: true; render: boolean } | undefined } {
  let lines: string[] = [];
  return {
    render(width) {
      lines = render(width, isFoldable() ? isExpanded() ? "▾" : "▸" : undefined);
      return lines.length ? ["", ...lines] : [];
    },
    handleMouse(event) {
      if (!isFoldable() || (event.type !== "click" && event.type !== "press") || event.button !== "left" || event.shift || event.alt || event.ctrl ||
          event.x < 0 || event.x >= event.width || event.y < 1 || event.y > lines.length) return undefined;
      // Pi synthesizes click only for a component that handled the initial press.
      if (event.type === "press") return { handled: true, render: false };
      toggle();
      return { handled: true, render: true };
    },
    invalidate() { lines = []; },
  };
}