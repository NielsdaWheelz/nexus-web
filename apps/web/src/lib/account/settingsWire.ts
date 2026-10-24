// account settings use fixed bff operations on both hosted and installed clients.
// email sends are never automatically retried; unlink is idempotent.
export interface SettingsIdentity {
  id: string;
  provider: 'google' | 'github';
  email: string | null;
  created_at: string | null;
}
export interface EmailChangeResult {
  outcome: 'Sent' | 'InUse' | 'Invalid' | 'Failed';
}
export interface IdentityDeleteResult {
  outcome: 'Unlinked' | 'Failed';
}
