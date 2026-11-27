interface TransportReason {
  kind: string;
  id: number;
  connection: number;
}

/** A status response includes the probe itself until its dispatch returns. */
export function onlyStatusProbeRemains(status: {
  livenessReasons: TransportReason[];
  transportRequests: TransportReason[];
}): boolean {
  if (status.livenessReasons.length !== 1 || status.transportRequests.length !== 1) return false;
  const reason = status.livenessReasons[0]!;
  const probe = status.transportRequests[0]!;
  return reason.kind === "transport-request" && probe.kind === "transport-request"
    && reason.id === probe.id && reason.connection === probe.connection;
}
