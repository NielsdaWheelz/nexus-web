/**
 * Client-only recovery state for a run whose durable status could not be
 * confirmed after its live stream disconnected. This state never changes the
 * server-owned message status or failure projection.
 */
export type ChatConnectionRecovery =
  | {
      readonly kind: "Lost";
      readonly runId: string;
      readonly lastCursor: string;
    }
  | {
      readonly kind: "Reconnecting";
      readonly runId: string;
      readonly lastCursor: string;
    }
  | {
      readonly kind: "Failed";
      readonly runId: string;
      readonly lastCursor: string;
      readonly message: string;
      readonly requestId?: string;
      readonly retryable: boolean;
    };

export type ChatConnectionRecoveries = Readonly<
  Record<string, ChatConnectionRecovery>
>;
