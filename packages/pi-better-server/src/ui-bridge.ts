import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** A dialog an extension is waiting on. Shaped like Pi's RPC `extension_ui_request`. */
export interface PendingDialog {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

/** Answer to a dialog; same fields as Pi's RPC `extension_ui_response`, minus the id. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

type Resolution = "answered" | "timeout" | "abort" | "closed";

interface Waiter {
  dialog: PendingDialog;
  settle: (answer: DialogAnswer | undefined, how: Resolution) => void;
}

/**
 * Gives a headless Pi session an extension UI. Dialogs (select/confirm/input/
 * editor) are published as events and stay pending, whoever is or is not
 * connected, until someone answers, the extension's own timeout/abort fires,
 * or the session closes. Other UI calls (notify, setStatus, ...) are published
 * as fire-and-forget events, as in Pi's RPC mode.
 */
export class UiBridge {
  private readonly waiters = new Map<string, Waiter>();
  private readonly emit: (event: unknown) => void;

  constructor(emit: (event: unknown) => void) {
    this.emit = emit;
  }

  pending(): PendingDialog[] {
    return [...this.waiters.values()].map((waiter) => waiter.dialog);
  }

  /** Resolve a pending dialog. False when it is unknown (already answered, timed out, or never existed). */
  answer(requestId: string, answer: DialogAnswer): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    waiter.settle(answer, "answered");
    return true;
  }

  /** Release every waiting extension with a cancelled answer (the session is going away). */
  cancelAll(): void {
    for (const waiter of [...this.waiters.values()]) waiter.settle({ cancelled: true }, "closed");
  }

  private dialog<T>(spec: Omit<PendingDialog, "type" | "id">, opts: ExtensionUIDialogOptions | undefined, fallback: T, parse: (answer: DialogAnswer) => T): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(fallback);
    const dialog: PendingDialog = { type: "extension_ui_request", id: randomUUID(), ...spec };
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => waiter.settle(undefined, "abort");
      const waiter: Waiter = {
        dialog,
        settle: (answer, how) => {
          if (!this.waiters.delete(dialog.id)) return;
          if (timer) clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          this.emit({ type: "extension_ui_resolved", id: dialog.id, how });
          resolve(answer ? parse(answer) : fallback);
        },
      };
      this.waiters.set(dialog.id, waiter);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) timer = setTimeout(() => waiter.settle(undefined, "timeout"), opts.timeout);
      this.emit(dialog);
    });
  }

  private fire(request: Record<string, unknown>): void {
    this.emit({ type: "extension_ui_request", id: randomUUID(), ...request });
  }

  context(): ExtensionUIContext {
    const text = (answer: DialogAnswer): string | undefined => ("value" in answer ? answer.value : undefined);
    const context = {
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) => this.dialog({ method: "select", title, options, timeout: opts?.timeout }, opts, undefined as string | undefined, text),
      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) => this.dialog({ method: "confirm", title, message, timeout: opts?.timeout }, opts, false, (answer) => ("confirmed" in answer ? answer.confirmed : false)),
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => this.dialog({ method: "input", title, placeholder, timeout: opts?.timeout }, opts, undefined as string | undefined, text),
      editor: (title: string, prefill?: string) => this.dialog({ method: "editor", title, prefill }, undefined, undefined as string | undefined, text),
      notify: (message: string, type?: string) => this.fire({ method: "notify", message, notifyType: type }),
      setStatus: (key: string, statusText: string | undefined) => this.fire({ method: "setStatus", statusKey: key, statusText }),
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        if (content === undefined || Array.isArray(content)) this.fire({ method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      },
      setTitle: (title: string) => this.fire({ method: "setTitle", title }),
      setEditorText: (editorText: string) => this.fire({ method: "set_editor_text", text: editorText }),
      pasteToEditor(editorText: string) {
        this.setEditorText(editorText);
      },
      getEditorText: () => "",
      onTerminalInput: () => () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      custom: async () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported by the daemon" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
    // There is no terminal behind the daemon, so `theme` is left undefined (Pi's RPC mode is headless the same way).
    return context as unknown as ExtensionUIContext;
  }
}
