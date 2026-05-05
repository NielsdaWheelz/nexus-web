import { apiFetch } from "@/lib/api/client";
import type { ContributorSummary, ContributorWork } from "@/lib/contributors/types";

interface ContributorsResponse {
  data: {
    contributors: ContributorSummary[];
  };
}

interface ContributorResponse {
  data: ContributorSummary;
}

interface ContributorWorksResponse {
  data: {
    works: ContributorWork[];
  };
}

interface ContributorWorksFilters {
  role?: string;
  contentKind?: string;
  query?: string;
  limit?: number;
}

export async function fetchContributors(query: string): Promise<ContributorSummary[]> {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed) {
    params.set("q", trimmed);
  }
  const suffix = params.toString();
  const response = await apiFetch<ContributorsResponse>(
    suffix ? `/api/contributors?${suffix}` : "/api/contributors",
    { cache: "no-store" }
  );
  return Array.isArray(response.data.contributors) ? response.data.contributors : [];
}

export async function fetchContributor(handle: string): Promise<ContributorSummary> {
  const response = await apiFetch<ContributorResponse>(
    `/api/contributors/${encodeURIComponent(handle)}`,
    { cache: "no-store" }
  );
  return response.data;
}

export async function fetchContributorWorks(
  handle: string,
  filters: ContributorWorksFilters = {}
): Promise<ContributorWork[]> {
  const params = new URLSearchParams();
  const role = filters.role?.trim();
  if (role) {
    params.set("role", role);
  }
  const contentKind = filters.contentKind?.trim();
  if (contentKind) {
    params.set("content_kind", contentKind);
  }
  const query = filters.query?.trim();
  if (query) {
    params.set("q", query);
  }
  if (filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  const suffix = params.toString();
  const response = await apiFetch<ContributorWorksResponse>(
    `/api/contributors/${encodeURIComponent(handle)}/works${suffix ? `?${suffix}` : ""}`,
    { cache: "no-store" }
  );
  return Array.isArray(response.data.works) ? response.data.works : [];
}
