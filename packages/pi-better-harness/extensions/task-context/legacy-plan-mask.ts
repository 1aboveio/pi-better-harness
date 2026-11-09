import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import {
  DefaultResourceLoader,
  type Extension,
  type ExtensionContext,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

// Retires a separately installed pi-better-plan at load time. The public
// DefaultResourceLoader result is filtered after every factory ran and before the
// ExtensionRunner is built, then that record's own session_shutdown handlers run
// before this Harness installs its Todo widget (both use the same widget key).
// No settings, extension files, or runner internals are touched.

const LEGACY_PACKAGE_NAME = "pi-better-plan";
const MASK_STATE = Symbol.for("pi-better-harness.legacy-plan-mask");
const MISSING_GETTER_NOTICE = "pi-better-plan retirement mask not applied: this Pi SDK does not expose "
  + "DefaultResourceLoader.getExtensions(), so a separately installed pi-better-plan extension was left active.";
const UNEXPECTED_RESULT_NOTICE = "pi-better-plan retirement mask not applied: DefaultResourceLoader.getExtensions() "
  + "returned an unexpected result shape, so a separately installed pi-better-plan extension was left active.";

type Prototype = Record<PropertyKey, unknown>;
type SessionShutdownHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Provider { marker: unknown; pending: Set<Extension>; seen: WeakSet<Extension> }

export interface LegacyPlanMask {
  /** Set when the loader API or its result shape cannot be masked safely. */
  readonly notice: string | null;
  cleanup(ctx: ExtensionContext): Promise<void>;
  dispose(): void;
}

// The bundled CLI and the unbundled SDK export distinct loader classes.
function hostPrototype(): Prototype {
  if (process.argv[1]) {
    try {
      const launcher = realpathSync(process.argv[1]);
      const directory = dirname(launcher);
      if (basename(directory) === "bundle" && basename(dirname(directory)) === "dist") {
        const metadata = JSON.parse(readFileSync(join(directory, "../../package.json"), "utf8"));
        if (metadata.name === "@earendil-works/pi-coding-agent") {
          const host = createRequire(launcher)(join(directory, "index.js"));
          return host.DefaultResourceLoader?.prototype ?? {};
        }
      }
    } catch {
      // An unresolvable bundled host must report incompatibility, not patch a second SDK.
      return {};
    }
  }
  return DefaultResourceLoader.prototype as unknown as Prototype;
}
const loaderPrototype = hostPrototype();
const prototype = (): Prototype => loaderPrototype;
const maskState = (): MaskState | undefined => prototype()[MASK_STATE] as MaskState | undefined;

interface MaskState { original: () => unknown; wrapped?: () => unknown; providers: Set<Provider>; claimed: WeakSet<Extension>; notice: string | null }

/** Nearest real package.json name, walking up from the extension's resolved path. */
function nearestPackageName(entryPath: string): string | null {
  let dir: string;
  try { dir = dirname(realpathSync(entryPath)); }
  catch { return null; }
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      return typeof parsed.name === "string" ? parsed.name : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function legacyPlanRecord(record: Extension): boolean {
  const entry = record?.resolvedPath || record?.path;
  if (typeof entry !== "string" || !entry || entry.startsWith("<")) return false;
  return nearestPackageName(entry) === LEGACY_PACKAGE_NAME;
}

function belongsToProvider(record: Extension, provider: Provider): boolean {
  return record?.tools instanceof Map && record.tools.get("get_todo")?.definition.parameters === provider.marker;
}

/** Clones the loader result when this Harness instance is present, dropping retired records. */
function filterResult(state: MaskState, result: unknown): LoadExtensionsResult | null {
  const candidate = result as Partial<LoadExtensionsResult> | null;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.extensions)
    || !candidate.runtime || typeof candidate.runtime !== "object") {
    state.notice ??= UNEXPECTED_RESULT_NOTICE;
    return null;
  }
  const extensions = candidate.extensions as Extension[];
  const own = [...state.providers].filter(provider =>
    extensions.some(record => belongsToProvider(record, provider)));
  if (own.length === 0) return null;
  const legacy = extensions.filter(legacyPlanRecord);
  if (legacy.length === 0) return null;
  const owner = own[0]!;
  for (const record of legacy) {
    if (state.claimed.has(record) || owner.seen.has(record)) continue;
    owner.seen.add(record);
    owner.pending.add(record);
    state.claimed.add(record);
  }
  const removed = new Set(legacy);
  // Clone so the loader's cached result keeps every extension it loaded.
  return { ...(result as LoadExtensionsResult), extensions: extensions.filter(record => !removed.has(record)) };
}

function noticeReporter(read: () => string | null): (ctx: ExtensionContext) => void {
  let reported = false;
  return (ctx) => {
    const notice = read();
    if (!notice || reported) return;
    reported = true;
    if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
  };
}

export function installLegacyPlanMask(marker: unknown): LegacyPlanMask {
  const proto = prototype();
  let state = maskState();
  if (!state) {
    const original = proto.getExtensions;
    if (typeof original !== "function") {
      const reportMissing = noticeReporter(() => MISSING_GETTER_NOTICE);
      return {
        notice: MISSING_GETTER_NOTICE,
        async cleanup(ctx: ExtensionContext) { reportMissing(ctx); },
        dispose() {},
      };
    }
    const created: MaskState = {
      original: original as () => unknown,
      providers: new Set(),
      claimed: new WeakSet(),
      notice: null,
    };
    state = created;
    created.wrapped = function legacyPlanMaskedGetExtensions(this: unknown) {
      const result = created.original.call(this);
      return filterResult(created, result) ?? result;
    };
    proto.getExtensions = created.wrapped;
    Object.defineProperty(proto, MASK_STATE, { value: created, configurable: true, writable: true });
  }
  const current = state;
  const provider: Provider = { marker, pending: new Set(), seen: new WeakSet() };
  current.providers.add(provider);
  const report = noticeReporter(() => current.notice);
  return {
    get notice() {
      return current.notice;
    },
    async cleanup(ctx: ExtensionContext) {
      report(ctx);
      const records = [...provider.pending];
      provider.pending.clear();
      for (const record of records) {
        const handlers = record?.handlers instanceof Map ? record.handlers.get("session_shutdown") : undefined;
        for (const handler of handlers ?? []) {
          try {
            await (handler as SessionShutdownHandler)({ type: "session_shutdown", reason: "reload" }, ctx);
          } catch {
            // A retired plugin's cleanup must not break this session's start.
          }
        }
      }
    },
    dispose() {
      if (!current.providers.delete(provider)) return;
      provider.pending.clear();
      if (current.providers.size === 0 && maskState() === current && proto.getExtensions === current.wrapped) {
        proto.getExtensions = current.original;
        Reflect.deleteProperty(proto, MASK_STATE);
      }
    },
  };
}
