import type { EpisodeConsumptionObservation } from "@/lib/consumption/listening";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import type { ReaderProfile } from "@/lib/reader/ReaderContext";
import type { WorkspaceState } from "@/lib/workspace/model";

export interface WorkspaceBootstrap {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  /** Server seeds by pane id, then by the key of the hook that reads them. */
  seeds: Record<string, Record<string, unknown>>;
  /** Same reads, forwarded once after native registers its observation transport. */
  consumptionObservations: readonly EpisodeConsumptionObservation[];
  /** A rejected cold location is reported over the resumed valid workspace. */
  locationLinkFailure: "TooLong" | null;
}

export type EntryResult =
  | { kind: "Ready"; bootstrap: WorkspaceBootstrap }
  | { kind: "Unavailable"; requestId?: string };
