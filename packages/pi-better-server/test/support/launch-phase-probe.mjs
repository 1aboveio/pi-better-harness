import { createRequire, syncBuiltinESMExports } from "node:module";
import { WorkClient } from "../../../pi-better-subagents/shared-work-client.mjs";

const phases = new Map([
  ["hello", "hello"], ["runtime_register_client", "client-registration"],
  ["runtime_bind_catalog_host", "catalog-binding"], ["runtime_register_catalog", "catalog-registration"],
  ["runtime_launch_subagent", "launch-bridge"],
]);

/** Observe only the owned SDK fixture's existing operations; never await diagnostics. */
export function observeLaunchPhases(send) {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const request = WorkClient.prototype.request, spawn = childProcess.spawn;
  const started = performance.now();
  let count = 0, active = true;
  const begin = phase => {
    if (!active || count === 32) return () => {};
    const index = count++;
    const receipt = state => {
      try { send({ launchPhase: { index, phase, state, elapsedMs: Math.round(performance.now() - started) } }); }
      catch { /* A closed diagnostic channel cannot change the observed operation. */ }
    };
    receipt("started");
    let ended = false;
    return state => {
      if (!active || ended) return;
      ended = true;
      receipt(state);
    };
  };
  const toolEnd = begin("tool-execute");
  WorkClient.prototype.request = function(type, ...args) {
    const end = phases.has(type) ? begin(phases.get(type)) : () => {};
    try {
      const result = request.call(this, type, ...args);
      void result.then(() => end("finished"), () => end("failed"));
      return result;
    } catch (error) { end("failed"); throw error; }
  };
  childProcess.spawn = function(command, args, options) {
    // Shell close is the actual child completion. Detached spawn acceptance is
    // deliberately a different boundary: it is NOT daemon protocol readiness.
    const phase = command === "/bin/sh" ? "provision-shell" : options?.detached ? "detached-spawn" : undefined;
    if (!phase) return spawn.call(this, command, args, options);
    const end = begin(phase);
    try {
      const child = spawn.call(this, command, args, options);
      child.once(phase === "detached-spawn" ? "spawn" : "close", () => end("finished"));
      child.once("error", () => end("failed"));
      return child;
    } catch (error) { end("failed"); throw error; }
  };
  syncBuiltinESMExports();
  return (state = "finished") => {
    if (!active) return;
    toolEnd(state);
    active = false;
    WorkClient.prototype.request = request;
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
  };
}

/** Phase receipts cannot satisfy an authoritative tool reply. */
export function launchFixtureRequest(child, request, trace) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off("message", message); child.off("exit", exit); child.off("error", error); };
    const message = value => {
      if (value?.launchPhase) { trace?.launchPhase(value.launchPhase); return; }
      cleanup(); resolve(value);
    };
    const error = cause => { cleanup(); reject(cause); };
    const exit = code => error(new Error(`SDK fixture exited before launch receipt (code ${code})`));
    child.on("message", message); child.once("exit", exit); child.once("error", error);
    try { child.send(request, cause => { if (cause) error(cause); }); }
    catch (cause) { error(cause); }
  });
}
