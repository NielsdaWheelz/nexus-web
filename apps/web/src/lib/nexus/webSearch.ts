import { apiFetch } from "@/lib/api/client";
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectInteger,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";
import type { AddSeed } from "./model";

export interface NexusWebResult {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly displayUrl: string;
  readonly snippet: string;
  readonly sourceName: string | null;
  readonly rank: number;
  readonly score: number;
}

export class NexusWebContractDefect extends Error {
  constructor(message: string, cause: TypeError) {
    super(message, { cause });
    this.name = "NexusWebContractDefect";
  }
}

const WEB_RESULT_KEYS = [
  "type",
  "id",
  "result_type",
  "result_ref",
  "source_id",
  "title",
  "url",
  "display_url",
  "deep_link",
  "citation_target",
  "locator",
  "snippet",
  "extra_snippets",
  "published_at",
  "source_name",
  "rank",
  "provider",
  "provider_request_id",
  "context_ref",
  "media_id",
  "media_kind",
  "score",
  "selected",
] as const;

export function decodeNexusWebResult(
  raw: unknown,
  index = 0,
): NexusWebResult {
  const name = `web search results[${index}]`;
  const value = expectExactRecord(raw, WEB_RESULT_KEYS, name);
  expectOneOf(value.type, ["web_result"] as const, `${name}.type`);
  expectOneOf(
    value.result_type,
    ["web_result"] as const,
    `${name}.result_type`,
  );
  expectString(value.result_ref, `${name}.result_ref`);
  const sourceId = expectString(value.source_id, `${name}.source_id`);
  const id = expectString(value.id, `${name}.id`);
  if (id !== sourceId) {
    throw new TypeError(`${name}.id must match source_id`);
  }
  const deepLink = expectString(value.deep_link, `${name}.deep_link`);
  const citationTarget = expectString(
    value.citation_target,
    `${name}.citation_target`,
  );
  if (citationTarget !== `external_snapshot:${sourceId}`) {
    throw new TypeError(
      `${name}.citation_target must identify the source snapshot`,
    );
  }
  if (
    !isRetrievalLocator(value.locator) ||
    value.locator.type !== "external_url"
  ) {
    throw new TypeError(`${name}.locator must be an external_url locator`);
  }
  const contextRef = expectExactRecord(
    value.context_ref,
    ["type", "id"],
    `${name}.context_ref`,
  );
  expectOneOf(
    contextRef.type,
    ["web_result"] as const,
    `${name}.context_ref.type`,
  );
  const contextId = expectString(
    contextRef.id,
    `${name}.context_ref.id`,
  );
  if (contextId !== sourceId) {
    throw new TypeError(`${name}.context_ref.id must match source_id`);
  }
  expectArray(
    value.extra_snippets,
    (snippet, snippetIndex) =>
      expectString(snippet, `${name}.extra_snippets[${snippetIndex}]`),
    `${name}.extra_snippets`,
  );
  expectNullableString(value.published_at, `${name}.published_at`);
  const provider = expectString(value.provider, `${name}.provider`);
  if (!provider.trim()) {
    throw new TypeError(`${name}.provider must not be blank`);
  }
  expectNullableString(
    value.provider_request_id,
    `${name}.provider_request_id`,
  );
  if (value.media_id !== null) {
    throw new TypeError(`${name}.media_id must be null`);
  }
  if (value.media_kind !== null) {
    throw new TypeError(`${name}.media_kind must be null`);
  }
  expectBoolean(value.selected, `${name}.selected`);
  const url = expectString(value.url, `${name}.url`);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError(`${name}.url must be an http(s) URL`);
  }
  const parsedDeepLink = new URL(deepLink);
  if (
    (parsedDeepLink.protocol !== "http:" &&
      parsedDeepLink.protocol !== "https:") ||
    deepLink !== url
  ) {
    throw new TypeError(`${name}.deep_link must match the http(s) URL`);
  }
  const locatorUrl = new URL(value.locator.url);
  if (
    (locatorUrl.protocol !== "http:" &&
      locatorUrl.protocol !== "https:") ||
    value.locator.url !== url
  ) {
    throw new TypeError(`${name}.locator.url must match the http(s) URL`);
  }
  const title = expectString(value.title, `${name}.title`);
  const displayUrl = expectString(
    value.display_url,
    `${name}.display_url`,
  );
  if (
    value.locator.title !== title ||
    value.locator.display_url !== displayUrl
  ) {
    throw new TypeError(
      `${name}.locator title and display_url must match the result`,
    );
  }
  const rank = expectInteger(value.rank, `${name}.rank`);
  if (rank < 1) throw new TypeError(`${name}.rank must be positive`);
  const score = expectFiniteNumber(value.score, `${name}.score`);
  if (score !== 1 / rank) {
    throw new TypeError(`${name}.score must equal 1/rank`);
  }
  return {
    id,
    title,
    url: parsedUrl.toString(),
    displayUrl,
    snippet: expectString(value.snippet, `${name}.snippet`),
    sourceName: expectNullableString(
      value.source_name,
      `${name}.source_name`,
    ),
    rank,
    score,
  };
}

export async function searchNexusWeb(input: {
  readonly query: string;
  readonly signal?: AbortSignal;
}): Promise<readonly NexusWebResult[]> {
  const params = new URLSearchParams({ q: input.query });
  const response = await apiFetch<{ data: unknown }>(
    `/api/web/search?${params.toString()}`,
    { signal: input.signal },
  );
  try {
    const data = expectExactRecord(response.data, ["results"], "web search");
    return expectArray(
      data.results,
      decodeNexusWebResult,
      "web search.results",
    );
  } catch (error) {
    if (error instanceof TypeError) {
      throw new NexusWebContractDefect(error.message, error);
    }
    throw error;
  }
}

export function webResultAddSeed(result: NexusWebResult): AddSeed {
  return {
    kind: "Content",
    initialFocus: "Url",
    initialDestinations: [],
    initialUrlDraft: result.url,
  };
}
