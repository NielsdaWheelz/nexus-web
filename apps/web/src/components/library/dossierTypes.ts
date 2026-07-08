// Shared shapes for the inline library brief family (LibraryBrief +
// LibraryBriefLede/Artifact/Controls/Revisions). Data-only; mirrors the
// existing `/api/libraries/{id}/intelligence*` payloads unchanged (N4).
import type { CitationOut } from "@/lib/conversations/citationOut";

export type ArtifactStatus =
  | "unavailable"
  | "building"
  | "failed"
  | "stale"
  | "current";

export interface LibraryIntelligenceBuild {
  revision_id: string;
  status: "building" | "ready" | "failed";
}

export interface LibraryIntelligenceArtifact {
  artifact_id: string | null;
  artifact_ref: string | null;
  revision_id: string | null;
  revision_ref: string | null;
  status: ArtifactStatus;
  content_md: string;
  citations: CitationOut[];
  stale_source_count: number | null;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
  build: LibraryIntelligenceBuild | null;
}

export interface LibraryIntelligenceRevision {
  artifact_id: string;
  artifact_ref: string;
  revision_id: string;
  revision_ref: string;
  status: "building" | "ready" | "failed";
  content_md: string;
  citations: CitationOut[];
  created_at: string;
  promoted_at: string | null;
  is_current: boolean;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
}

export interface RevisionSummary {
  artifact_id: string;
  artifact_ref: string;
  revision_id: string;
  revision_ref: string;
  status: "building" | "ready" | "failed";
  created_at: string;
  promoted_at: string | null;
  is_current: boolean;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
}
