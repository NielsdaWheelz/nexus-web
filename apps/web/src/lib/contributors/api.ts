import { type ApiPath, apiFetch } from "@/lib/api/client";
import {
  contributorDirectoryResource,
  type ContributorDirectoryResourceParams,
  contributorResource,
  contributorWorksResource,
} from "@/lib/api/resource";
import type {
  ContributorDirectoryPage,
  ContributorSummary,
  ContributorWork,
} from "@/lib/contributors/types";

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

export async function fetchContributorDirectory(
  params: ContributorDirectoryResourceParams
): Promise<ContributorDirectoryPage> {
  const response = await apiFetch<{ data: ContributorDirectoryPage }>(
    contributorDirectoryResource.clientPath(params),
    { cache: "no-store" }
  );
  return response.data;
}

export async function fetchContributor(handle: string): Promise<ContributorSummary> {
  const response = await apiFetch<ContributorResponse>(
    contributorResource.clientPath({ handle }),
    { cache: "no-store" }
  );
  return response.data;
}

export async function fetchContributorWorks(
  handle: string,
  filters: ContributorWorksFilters = {}
): Promise<ContributorWork[]> {
  const response = await apiFetch<ContributorWorksResponse>(
    contributorWorksResource.clientPath({
      handle,
      role: filters.role,
      contentKind: filters.contentKind,
      query: filters.query,
      limit: filters.limit,
    }),
    { cache: "no-store" }
  );
  return Array.isArray(response.data.works) ? response.data.works : [];
}

async function contributorMutation(
  path: ApiPath,
  init: RequestInit
): Promise<ContributorSummary> {
  const response = await apiFetch<ContributorResponse>(path, init);
  return response.data;
}

export async function mergeContributor(
  handle: string,
  targetHandle: string
): Promise<ContributorSummary> {
  return contributorMutation(`/api/contributors/${encodeURIComponent(handle)}/merge`, {
    method: "POST",
    body: JSON.stringify({ target_handle: targetHandle }),
  });
}

export async function tombstoneContributor(handle: string): Promise<ContributorSummary> {
  return contributorMutation(`/api/contributors/${encodeURIComponent(handle)}/tombstone`, {
    method: "POST",
  });
}

export async function splitContributor(
  handle: string,
  body: {
    display_name: string;
    credit_ids?: string[];
    alias_ids?: string[];
    external_id_ids?: string[];
    object_link_ids?: string[];
  }
): Promise<ContributorSummary> {
  return contributorMutation(`/api/contributors/${encodeURIComponent(handle)}/split`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function addContributorAlias(
  handle: string,
  body: { alias: string; alias_kind?: string; source?: string }
): Promise<ContributorSummary> {
  return contributorMutation(`/api/contributors/${encodeURIComponent(handle)}/aliases`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteContributorAlias(
  handle: string,
  aliasId: string
): Promise<ContributorSummary> {
  return contributorMutation(
    `/api/contributors/${encodeURIComponent(handle)}/aliases/${encodeURIComponent(aliasId)}`,
    { method: "DELETE" }
  );
}

export async function addContributorExternalId(
  handle: string,
  body: { authority: string; external_key: string; external_url?: string; source?: string }
): Promise<ContributorSummary> {
  return contributorMutation(`/api/contributors/${encodeURIComponent(handle)}/external-ids`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteContributorExternalId(
  handle: string,
  externalIdId: string
): Promise<ContributorSummary> {
  return contributorMutation(
    `/api/contributors/${encodeURIComponent(handle)}/external-ids/${encodeURIComponent(externalIdId)}`,
    { method: "DELETE" }
  );
}
