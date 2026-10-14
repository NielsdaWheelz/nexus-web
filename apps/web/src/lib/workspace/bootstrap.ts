import type { AuthenticatedAccount } from "@/lib/account/contract";
import type { DehydratedResources } from "@/lib/api/resourceCache";
import type { ReaderProfile } from "@/lib/reader/ReaderContext";
import type { WorkspaceState } from "@/lib/workspace/model";

export interface WorkspaceBootstrap {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}

export type EntryResult =
  | { kind: "Ready"; bootstrap: WorkspaceBootstrap }
  | { kind: "Unavailable"; requestId?: string };
