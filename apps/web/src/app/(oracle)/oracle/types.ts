/**
 * Shared API response shapes for the Oracle routes.
 */

export interface OracleCreateResponse {
  reading_id: string;
  folio_number: number;
  status: string;
  stream: {
    token: string;
    stream_base_url: string;
    event_url: string;
    expires_at: string;
  };
}
