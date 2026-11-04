/** Whether a modeled write failure proves nothing ran. Transport adapters own error identity
 * and defect handling; this pure partition has no browser, account or lifecycle state. */
export function writeRefused({ sent, status, code }: { readonly sent: boolean; readonly status: number | null; readonly code: string }): boolean {
  return !sent || status !== null && status >= 400 && status < 500 || code === "E_AUTH_UNAVAILABLE";
}
