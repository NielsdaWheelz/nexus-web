"use client";

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import { WorkspaceSessionStore, type PendingWorkspaceSession } from "./sessionStore";
import { parsePersistedWorkspaceState, type WorkspaceState } from "./schema";
import { workspaceStatesEqual } from "./workspaceRestore";

export type WorkspaceSaveState =
  | { readonly kind: "Saved" | "Saving" | "Pending" }
  | { readonly kind: "LocalFailure" | "SyncFailure"; readonly error: unknown };
const SAVE_IDLE_MS = 1000;

// A writer serializes delivery; IndexedDB acknowledgment compares its exact
// sequence. Other windows retain the server's commit-order last-write-wins rule.
// The account-bound endpoint is the durability owner: the local row is a
// recovery copy, so its loss narrows the claimed status, never the delivery.
export class WorkspaceSessionWriter {
  private readonly store = new WorkspaceSessionStore();
  private readonly writerId = crypto.randomUUID();
  private sequence = 0;
  private persistedSequence = 0;
  private acknowledgedSequence = 0;
  private repersistedSequence = 0;
  private localFailure: { readonly error: unknown } | undefined;
  private desired: WorkspaceState;
  private captured: Promise<void> = Promise.resolve();
  private inFlight: Promise<void> | undefined;
  private flushRequested = false;
  private cancelDelivery: (() => void) | undefined;
  private closed = false;
  private keepalive = false;

  constructor(
    private readonly accountId: string,
    seed: WorkspaceState,
    private readonly report: (state: WorkspaceSaveState) => void,
    private recovered: PendingWorkspaceSession | null,
    private readonly scheduleDelivery: (deliver: () => void) => () => void = (deliver) => {
      const timer = setTimeout(deliver, SAVE_IDLE_MS);
      return () => { clearTimeout(timer); };
    },
  ) {
    this.desired = recovered?.state ?? seed;
  }

  capture(state: WorkspaceState): void {
    if (workspaceStatesEqual(state, this.desired)) return;
    this.desired = state;
    this.sequence += 1;
    this.persist();
  }

  private persist(): void {
    const row: PendingWorkspaceSession = {
      accountId: this.accountId, writerId: this.writerId,
      sequence: this.sequence, state: this.desired,
    };
    this.report({ kind: "Saving" });
    this.captured = this.captured.then(async () => {
      await this.store.put(row);
      this.persistedSequence = row.sequence;
      this.localFailure = undefined;
      if (this.closed || this.sequence !== row.sequence) return;
      this.report({ kind: "Pending" });
      this.armDelivery();
    }).catch((error: unknown) => {
      this.localFailure = { error };
      if (this.closed || this.sequence !== row.sequence) return;
      // Unretained work still has a durable owner, so delivery is still due.
      this.report({ kind: "LocalFailure", error });
      this.armDelivery();
    });
  }

  private armDelivery(): void {
    this.cancelDelivery?.();
    this.cancelDelivery = this.scheduleDelivery(() => {
      this.cancelDelivery = undefined;
      this.flush();
    });
  }

  // A writer that could not retain its own copy never claims local durability.
  private publish(state: WorkspaceSaveState): void {
    this.report(this.localFailure === undefined
      ? state
      : { kind: "LocalFailure", error: this.localFailure.error });
  }

  retry(): void {
    if (this.sequence > this.acknowledgedSequence) this.persist();
    this.flush();
  }

  flush(keepalive = false): void {
    this.keepalive = keepalive;
    this.cancelDelivery?.();
    this.cancelDelivery = undefined;
    if (this.closed) return;
    if (this.inFlight !== undefined) {
      this.flushRequested = true;
      return;
    }
    this.flushRequested = false;
    this.inFlight = this.deliver().catch((error: unknown) => {
      if (!this.closed) this.report({
        kind: this.localFailure === undefined ? "SyncFailure" : "LocalFailure", error,
      });
    }).finally(() => {
      this.inFlight = undefined;
      if (this.flushRequested) this.flush(this.keepalive);
    });
  }

  private async deliver(): Promise<void> {
    while (!this.closed) {
      await this.captured;
      if (this.recovered === null && this.acknowledgedSequence === this.sequence) {
        this.publish({ kind: "Saved" });
        return;
      }
      // A retained writer waits for its own newer capture to commit; an
      // unretained one has nothing to wait for and delivers from memory.
      const retained = this.localFailure === undefined;
      if (retained && this.persistedSequence < this.sequence) return;
      const stored = this.recovered
        ?? (retained ? await this.store.get(this.accountId, this.writerId) : undefined);
      if (this.closed) return;
      if (retained && stored === undefined) {
        // A missing row proves only that this device no longer holds it:
        // eviction and cleared site data are indistinguishable from another
        // owner's acknowledgment, and nothing here was ever delivered. Restore
        // the recovery copy and deliver; only a decoded acknowledgment saves.
        // A copy that vanishes again is storage this device cannot retain.
        if (this.repersistedSequence === this.sequence) {
          this.localFailure = { error: new Error("Workspace storage did not retain the pending layout") };
          continue;
        }
        this.repersistedSequence = this.sequence;
        this.persist();
        continue;
      }
      // Without a retained copy the writer's own desired state is the payload.
      const row = stored ?? {
        accountId: this.accountId, writerId: this.writerId,
        sequence: this.sequence, state: this.desired,
      };
      this.publish({ kind: "Pending" });
      const response = await apiFetch<unknown>("/api/me/workspace-session", {
          method: "PUT",
          headers: { "X-Nexus-Expected-Account-Id": this.accountId },
          body: JSON.stringify({ state: row.state }),
          ...(this.keepalive ? { keepalive: true } : {}),
      });
      decodeApiPayload(response, (value) => {
        if (!isRecord(value) || !isRecord(value.data)) {
          throw new Error("Workspace save returned no acknowledgment");
        }
        const acknowledged = parsePersistedWorkspaceState(value.data.state, {
          baseOrigin: window.location.origin,
        });
        if (!workspaceStatesEqual(acknowledged, row.state)) {
          throw new Error("Workspace save acknowledged a different layout");
        }
      }, "Workspace session save");
      if (stored !== undefined) await this.store.remove(row);
      if (row === this.recovered) this.recovered = null;
      if (row.writerId === this.writerId) {
        this.acknowledgedSequence = row.sequence;
        // Delivered work needs no local retention, so the claim is resolved.
        if (row.sequence === this.sequence) this.localFailure = undefined;
      }
    }
  }

  close(): void {
    this.closed = true;
    this.cancelDelivery?.();
    // A dispatched write may still acknowledge. Local capture transactions also
    // finish; the next account-bound owner recovers their rows before delivery.
  }
}
