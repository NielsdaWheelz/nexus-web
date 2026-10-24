// installed startup and credential-owner wire contracts. account binding grants
// local access only; a fresh bootstrap alone admits remote operations.
import type { Schema } from '@/lib/api/wire';

export type RemoteAdmission = 'Checking' | 'Ready' | 'Unavailable' | 'SignInRequired' | 'UpdateRequired';
export type SignInResult = 'Restored' | 'Cancelled' | 'DifferentAccount' | 'Failed';
export interface NativeBootstrap {
  account: { account_id: string; calendar_time_zone: string };
  reader_profile: Schema<'ReaderProfileOut'>;
  workspace: Schema<'WorkspaceState-Output'>;
  refresh_after_ms: number;
}
export interface DeviceStartup {
  format_version: 1;
  binding: (Pick<NativeBootstrap, 'account' | 'reader_profile' | 'workspace'> & {
    workspace_revision: Schema<'OrderRevision'>;
  }) | null;
}
export interface NativeHandoffRequest {
  code: string;
  verifier: string;
  expected_account_id: string | null;
}

/** Snapshot identifies the usable durably published catalog. Status also reports
 * refresh activity and failure; refresh acceptance does not mean completion. */
export interface CatalogStatus {
  snapshot: { snapshot_id: string; captured_at: string } | null;
  refreshing: boolean;
  last_error: { code: string; message: string } | null;
}
