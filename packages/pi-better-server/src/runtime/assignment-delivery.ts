import { acquireMutationStore } from "./mutation-store.ts";

interface Recipient {
  kind: "parent-session" | "worker-conversation";
  sessionId: string;
  workspace: string;
  branchId?: string | null;
  goalId?: string | null;
}
const sameRecipient = (a: Recipient, b: Recipient) => a.kind === b.kind
  && a.sessionId === b.sessionId && a.workspace === b.workspace
  && (a.branchId ?? null) === (b.branchId ?? null) && (a.goalId ?? null) === (b.goalId ?? null);

/** Internal fixed-host port. The host supplies the accepted recipient binding;
 * socket input must never construct this authority. Reading does not dispatch a
 * model turn, write a transcript, or consume the retained outcome. */
export class AssignmentDelivery {
  private lease: ReturnType<typeof acquireMutationStore>;
  private recipient: Recipient;
  constructor(root: string, recipient: Recipient) {
    this.recipient = Object.freeze({ ...recipient });
    this.lease = acquireMutationStore(root);
  }
  get(assignmentId: string) {
    const record = this.lease.store.getAssignmentOutcome(assignmentId);
    if (!record) return null;
    if (!sameRecipient(record.recipient, this.recipient)) throw new Error("assignment-recipient-refused");
    return record;
  }
  receipt(assignmentId: string, revision: number, entryId: string) {
    if (!this.get(assignmentId)) throw new Error("assignment-outcome-unavailable");
    return this.lease.store.receiptAssignmentOutcome({ assignmentId, revision, entryId, recipient: this.recipient });
  }
  close() { this.lease.release(); }
}
