export interface ContributorCredit {
  id?: string | null;
  contributor_handle: string;
  contributor_display_name?: string | null;
  credited_name: string;
  role: string | null;
  raw_role?: string | null;
  ordinal?: number | null;
  source?: string | null;
  source_ref?: Record<string, unknown> | null;
  resolution_status?: string | null;
  confidence?: string | number | null;
  href?: string | null;
}

export interface ContributorSummary {
  handle: string;
  contributor_handle?: string;
  display_name: string;
  sort_name: string;
  kind?: string | null;
  status?: string | null;
  disambiguation?: string | null;
  href?: string | null;
  aliases?: ContributorAlias[];
  external_ids?: ContributorExternalId[];
}

export interface ContributorAlias {
  id?: string;
  alias: string;
  alias_kind?: string | null;
  sort_name?: string | null;
  source?: string | null;
  is_primary?: boolean | null;
}

export interface ContributorExternalId {
  id?: string;
  authority: string;
  external_key: string;
  external_url?: string | null;
  source?: string | null;
}

export type ContributorReconciliationStatus = "pending" | "accepted" | "rejected" | "stale";

export interface ContributorReconciliationContributor {
  handle: string;
  href: string;
  display_name: string;
  sort_name: string;
  kind: string;
  status: string;
  disambiguation?: string | null;
  work_count: number;
}

export interface ContributorReconciliationEvidence {
  matcher?: string;
  reason?: string;
  signals?: string[];
  shared_aliases?: string[];
  shared_confirmed_aliases?: string[];
  shared_names?: string[];
  name_hit_count?: number;
  shared_work_count?: number;
  source_handle?: string;
  target_handle?: string;
  [key: string]: unknown;
}

export interface ContributorReconciliationCandidate {
  id: string;
  run_id: string;
  status: ContributorReconciliationStatus;
  score: number;
  source_contributor: ContributorReconciliationContributor;
  target_contributor: ContributorReconciliationContributor;
  evidence: ContributorReconciliationEvidence;
  decided_by_user_id?: string | null;
  created_at: string;
  updated_at: string;
  decided_at?: string | null;
}

export interface ContributorReconciliationCandidatesPage {
  candidates: ContributorReconciliationCandidate[];
}

export interface ContributorWork {
  object_type: string;
  object_id: string | number;
  route: string;
  title: string;
  content_kind: string;
  role?: string | null;
  credited_name?: string | null;
  published_date?: string | null;
  publisher?: string | null;
  description?: string | null;
  source?: string | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface ContributorDirectoryFacets {
  roles: FacetCount[];
  kinds: FacetCount[];
  content_kinds: FacetCount[];
  statuses: FacetCount[];
}

export interface ContributorDirectoryEntry {
  handle: string;
  href: string;
  display_name: string;
  sort_name: string;
  kind: string;
  status: string;
  disambiguation?: string | null;
  work_count: number;
  roles: string[];
  content_kinds: string[];
}

export interface ContributorDirectoryPage {
  entries: ContributorDirectoryEntry[];
  facets: ContributorDirectoryFacets;
  page: { has_more: boolean; next_cursor: string | null };
}
