import { recordQuerySample } from "./query-phase-diagnostics.mjs";
export function bootstrapHeartbeat(port, diagnostics) {
  if (diagnostics) {
    const post = port.postMessage;
    port.postMessage = function(message, ...args) {
      if (message.type === "heartbeat") recordQuerySample(diagnostics, "sent");
      return post.call(this, message, ...args);
    };
  }
  let pending = false;
  const consumed = message => { if (message.type === "heartbeat-consumed") { recordQuerySample(diagnostics, "bootstrapConsumed"); pending = false; } };
  port.on("message", consumed);
  const heartbeat = () => {
    if (pending) return;
    pending = true;
    recordQuerySample(diagnostics, "bootstrapSent");
    port.postMessage({ type: "heartbeat" });
  };
  // Cold setup has already consumed watchdog time when this entrypoint runs.
  heartbeat();
  const timer = setInterval(heartbeat, 250);
  timer.unref();
  return () => { clearInterval(timer); port.off("message", consumed); };
}
