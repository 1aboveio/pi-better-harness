export function bootstrapHeartbeat(port) {
  let pending = false;
  const consumed = message => { if (message.type === "heartbeat-consumed") pending = false; };
  port.on("message", consumed);
  const heartbeat = () => {
    if (pending) return;
    pending = true;
    port.postMessage({ type: "heartbeat" });
  };
  // Cold setup has already consumed watchdog time when this entrypoint runs.
  heartbeat();
  const timer = setInterval(heartbeat, 250);
  timer.unref();
  return () => { clearInterval(timer); port.off("message", consumed); };
}
