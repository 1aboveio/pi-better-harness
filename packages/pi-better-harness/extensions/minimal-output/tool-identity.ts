import type { Theme } from "@earendil-works/pi-coding-agent";

type RGB = [number, number, number];
interface ConcreteColor { kind: string; index?: number; r?: number; g?: number; b?: number }
const concreteColors = (theme: Theme) => (theme as Theme & { colors?: Record<string, ConcreteColor> }).colors;
const PERIOD = 2400;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function themeRgb(theme: Theme, token: "accent" | "text"): RGB | undefined {
  const color = concreteColors(theme)?.[token];
  if (color?.kind === "rgb" && color.r !== undefined && color.g !== undefined && color.b !== undefined) {
    return [color.r, color.g, color.b];
  }
  return rgb(theme.getFgAnsi(token));
}

export function supportsToolShimmer(theme: Theme): boolean {
  const base = themeRgb(theme, "accent");
  const light = themeRgb(theme, "text");
  const accent = concreteColors(theme)?.accent;
  return (!!base && !!light && base.some((value, index) => value !== light[index]))
    || (accent?.kind === "indexed" && accent.index !== undefined && accent.index >= 0 && accent.index < 16);
}

function rgb(ansi: string): RGB | undefined {
  const direct = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
  if (direct) return [Number(direct[1]), Number(direct[2]), Number(direct[3])];
  const indexed = /\x1b\[38;5;(\d+)m/.exec(ansi);
  if (!indexed) return undefined;
  const index = Number(indexed[1]);
  // The first 16 colors are terminal-defined; keep them untouched rather than guess.
  if (index < 16 || index > 255) return undefined;
  if (index >= 232) { const gray = 8 + (index - 232) * 10; return [gray, gray, gray]; }
  const cube = index - 16;
  const channel = (value: number) => value === 0 ? 0 : 55 + value * 40;
  return [channel(Math.floor(cube / 36)), channel(Math.floor(cube / 6) % 6), channel(cube % 6)];
}

function foreground(color: RGB, mode: "truecolor" | "256color"): string {
  if (mode === "truecolor") return `\x1b[38;2;${color.join(";")}m`;
  const channel = (value: number) => Math.max(0, Math.min(5, Math.round((value - 55) / 40)));
  const index = 16 + channel(color[0]) * 36 + channel(color[1]) * 6 + channel(color[2]);
  return `\x1b[38;5;${index}m`;
}

export function toolIdentity(icon: string, label: string, tone: "accent" | "muted" | "error", theme: Theme, time?: number): string {
  if (tone !== "accent" || time === undefined) return theme.fg(tone, `${icon} ${label}`);
  const base = themeRgb(theme, "accent");
  const light = themeRgb(theme, "text");
  if (!supportsToolShimmer(theme)) return theme.fg(tone, `${icon} ${label}`);
  const letters = Array.from(graphemes.segment(label), part => part.segment);
  const radius = Math.max(2, Math.min(4, letters.length / 3));
  const position = (time % PERIOD) / PERIOD * (letters.length + radius * 2) - radius;
  const mode = theme.getColorMode();
  const name = letters.map((letter, index) => {
    const distance = Math.abs(index - position) / radius;
    const shine = distance < 1 ? (1 + Math.cos(distance * Math.PI)) * 0.48 : 0;
    if (!base || !light) {
      const intensity = shine > 0.72 ? "\x1b[1m" : shine > 0.18 ? "" : "\x1b[2m";
      return `\x1b[22m${intensity}${letter}`;
    }
    const color = base.map((value, channel) => Math.round(value + (light[channel] - value) * shine)) as RGB;
    return `${foreground(color, mode)}${letter}`;
  }).join("");
  return theme.fg(tone, `${icon} \x1b[22m${name}\x1b[22m`);
}
