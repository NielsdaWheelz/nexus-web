import {
  expectBoolean,
  expectExactRecord,
} from "@/lib/validation";

export interface MediaActionCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
  can_delete: boolean;
  can_retry: boolean;
  can_refresh_source: boolean;
  can_retry_metadata: boolean;
  can_repair_source: boolean;
  can_repair_search: boolean;
  can_edit_authors: boolean;
  can_read_embeds: boolean;
}

export function decodeMediaActionCapabilities(
  raw: unknown,
  name = "MediaActionCapabilities",
): MediaActionCapabilities {
  const capabilities = expectExactRecord(
    raw,
    [
      "can_read",
      "can_highlight",
      "can_quote",
      "can_search",
      "can_play",
      "can_download_file",
      "can_delete",
      "can_retry",
      "can_refresh_source",
      "can_retry_metadata",
      "can_repair_source",
      "can_repair_search",
      "can_edit_authors",
      "can_read_embeds",
    ],
    name,
  );
  return {
    can_read: expectBoolean(capabilities.can_read, `${name}.can_read`),
    can_highlight: expectBoolean(
      capabilities.can_highlight,
      `${name}.can_highlight`,
    ),
    can_quote: expectBoolean(capabilities.can_quote, `${name}.can_quote`),
    can_search: expectBoolean(capabilities.can_search, `${name}.can_search`),
    can_play: expectBoolean(capabilities.can_play, `${name}.can_play`),
    can_download_file: expectBoolean(
      capabilities.can_download_file,
      `${name}.can_download_file`,
    ),
    can_delete: expectBoolean(capabilities.can_delete, `${name}.can_delete`),
    can_retry: expectBoolean(capabilities.can_retry, `${name}.can_retry`),
    can_refresh_source: expectBoolean(
      capabilities.can_refresh_source,
      `${name}.can_refresh_source`,
    ),
    can_retry_metadata: expectBoolean(
      capabilities.can_retry_metadata,
      `${name}.can_retry_metadata`,
    ),
    can_repair_source: expectBoolean(
      capabilities.can_repair_source,
      `${name}.can_repair_source`,
    ),
    can_repair_search: expectBoolean(
      capabilities.can_repair_search,
      `${name}.can_repair_search`,
    ),
    can_edit_authors: expectBoolean(
      capabilities.can_edit_authors,
      `${name}.can_edit_authors`,
    ),
    can_read_embeds: expectBoolean(
      capabilities.can_read_embeds,
      `${name}.can_read_embeds`,
    ),
  };
}
