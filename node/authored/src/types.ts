/** Shared authored state and replication vocabulary. Decimal counters are exact signed
 * 64-bit SQL values. Patches carry causal evidence, never replacement projections. */
export const FORMAT_REVISION = 1;
export const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
export type Counter = string;
export type ResourceRef = string;
export type Vector = Readonly<Record<string, Counter>>;
export interface Stamp { lamport: Counter; replica_id: string }
export interface Register<T> { value: T; stamp: Stamp }
export type Publication = { kind: "reader"; generation: number } | { kind: "note_text"; sha256: string };
export interface QuoteSelector extends Record<string, unknown> { exact: string; prefix: string | null; suffix: string | null }
export interface Quad { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number; x4: number; y4: number }
export type Locator =
  | { type: "web_text_offsets"; media_id: string; fragment_id: string; start_offset: number; end_offset: number; media_kind: string | null; text_quote_selector: QuoteSelector | null }
  | { type: "epub_fragment_offsets"; media_id: string; section_id: string | null; fragment_id: string; start_offset: number; end_offset: number; media_kind: string | null; text_quote_selector: QuoteSelector | null }
  | { type: "note_block_offsets"; block_id: string; start_offset: number; end_offset: number; text_quote_selector: QuoteSelector | null; body_version: number | null }
  | { type: "pdf_page_geometry"; media_id: string; page_number: number; quads: Quad[]; exact: string; prefix: string | null; suffix: string | null; text_quote_selector: QuoteSelector | null; projection: "proportional_text_offsets" | null }
  | { type: "pdf_page"; media_id: string; page_number: number }
  | { type: "transcript_time_range"; media_id: string; t_start_ms: number; t_end_ms: number; text_quote_selector: QuoteSelector | null }
  | { type: "audio_time_range" | "video_time_range"; media_id: string; t_start_ms: number; t_end_ms: number }
  | { type: "message_offsets"; conversation_id: string; message_id: string; start_offset: number; end_offset: number; message_seq: number | null; text_quote_selector: QuoteSelector | null }
  | { type: "external_url"; url: string; title: string | null; display_url: string | null; accessed_at: string | null };
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type HighlightLocator = Extract<Locator, {type:"web_text_offsets" | "epub_fragment_offsets" | "pdf_page_geometry"}>;
export interface SelectionCapture { publication: Publication | null; locator: HighlightLocator; quote_exact: string; prefix: string | null; suffix: string | null; passage_ref: ResourceRef | null }
interface ResourceCausality { ref: ResourceRef; touch_vv: Vector; delete_vv: Vector }
export interface NotePatch extends ResourceCausality { kind: "note"; body_update: string | null }
export interface PagePatch extends ResourceCausality { kind: "page"; local_date: string | null; title_update: string | null }
export interface HighlightPatch extends ResourceCausality { kind: "highlight"; source_ref: ResourceRef; selection: Register<SelectionCapture>; color: Register<HighlightColor> }
export type ResourcePatch = NotePatch | PagePatch | HighlightPatch;
export interface NoteState extends ResourceCausality { kind: "note"; body_state: string }
export interface PageState extends ResourceCausality { kind: "page"; local_date: string | null; title_state: string }
export type ResourceState = NoteState | PageState | HighlightPatch;
export interface LinkState { link_id: string; endpoint_a: ResourceRef; endpoint_b: ResourceRef; add_vv: Vector; remove_vv: Vector; position_a: Register<string> | null; position_b: Register<string> | null }
export interface PassageCapture { quote_exact: string; publication: Publication | null; locator: Locator | null }
export interface PassageState { anchor_id: string; source_ref: ResourceRef; normalized_exact: string; prefix: string; suffix: string; capture: Register<PassageCapture> }
export interface SourceCapture { kind: string; label: string; publication: Publication | null }
export interface SourceStub { source_ref: ResourceRef; capture: Register<SourceCapture> }
export interface Change { command_seq: Counter; lamport: Counter; resources: ResourcePatch[]; links: LinkState[]; passages: PassageState[]; source_stubs: SourceStub[] }
export interface Corpus { resources: ResourceState[]; links: LinkState[]; passages: PassageState[]; source_stubs: SourceStub[] }
export interface ResourceProjection { ref: ResourceRef; kind: ResourceState["kind"] | "source"; visible: boolean; body_pm_json: Record<string, unknown> | null; body_text: string | null; title: string | null; local_date: string | null; source_ref: ResourceRef | null; selection: SelectionCapture | null; color: HighlightColor | null; embedded_refs: string[] }
export interface MergeResult extends Corpus { projections: ResourceProjection[] }
export interface FeedChange { server_seq: Counter; replica_id: string; change: Change }
export interface ReplicaState { account_id: string; replica_id: string; command_seq: Counter; store_revision: Counter; lamport: Counter; server_cursor: Counter; format_revision: number; provisioning_complete: boolean }
export type SyncStatus = "preparing" | "saving" | "offline" | "syncing" | "current" | "sign_in_required" | "update_required" | "local_error" | "sync_error";
export type SemanticKey =
  | { kind: "daily"; local_date: string }
  | { kind: "link"; endpoint_a: string; endpoint_b: string }
  | { kind: "passage"; source_ref: string; normalized_exact: string; prefix: string; suffix: string };
export type PositionQuery =
  | { kind: "tail" }
  | { kind: "neighbors"; link_id: string; side: "before" | "after" }
  | { kind: "tie"; position: string; cursor: string | null; limit: number }
  | { kind: "bounds"; position: string };
export type AuthoredQuery =
  | { kind: "positions"; ref: ResourceRef; exclude_link_id: string | null; at: PositionQuery }
  | { kind: "adjacency_window"; ref: ResourceRef; link_id: string; cursor: string | null; limit: number }
  | { kind: "binding"; key: SemanticKey }
  | { kind: "resource"; ref: ResourceRef }
  | { kind: "adjacency"; ref: ResourceRef; cursor: string | null; limit: number }
  | { kind: "pages"; cursor: string | null; limit: number }
  | { kind: "daily"; local_date: string }
  | { kind: "annotation_notes"; source_ref: ResourceRef; cursor: string | null; limit: number }
  | { kind: "annotations"; source_ref: ResourceRef; cursor: string | null; limit: number }
  | { kind: "backlinks"; ref: ResourceRef; cursor: string | null; limit: number }
  | { kind: "search"; text: string; cursor: string | null; limit: number }
  | { kind: "resolve"; refs: ResourceRef[] };
export interface QueryRow { resource: ResourceProjection; link: LinkState | null }
export interface QueryResult { store_revision: Counter; rows: QueryRow[]; next_cursor: string | null; previous_cursor: string | null; binding_id: string | null; positions: LinkState[] }
export interface CommitFrame { expected_store_revision: Counter; replica_id: string; change: Change; states: MergeResult }
export type CommitResult = { kind: "committed"; command_seq: Counter; store_revision: Counter } | { kind: "stale"; store_revision: Counter; states: Corpus };
export interface StateSelection { refs: string[]; link_ids: string[]; anchor_ids: string[]; source_refs: string[] }
export interface AuthoredStore {
  withCommand<T>(work: () => Promise<T>): Promise<T>;
  readSnapshot(selection: StateSelection): Promise<{ replica: ReplicaState; states: Corpus }>;
  readReplica(): Promise<ReplicaState>;
  readStates(selection: StateSelection): Promise<Corpus>;
  whenUploaded(commandSeq: Counter, signal: AbortSignal): Promise<void>;
  query(query: AuthoredQuery): Promise<QueryResult>;
  subscribe(query: AuthoredQuery, listener: (result: QueryResult) => void): () => void;
  commit(frame: CommitFrame): Promise<CommitResult>;
  sync_status(listener: (status: SyncStatus, detail: string | null) => void): () => void;
  close(): Promise<void>;
}
