export function bootstrapHeartbeat(port) {
  let pending = false;
  const consumed = message => { if (message.type === "heartbeat-consumed") pending = false; };
  port.on("message", consumed);
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    port.postMessage({ type: "heartbeat" });
  }, 250);
  timer.unref();
  return () => { clearInterval(timer); port.off("message", consumed); };
}
