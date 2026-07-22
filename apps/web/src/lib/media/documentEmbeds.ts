import type { MediaPlaybackSource } from "@/lib/media/playback";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectInteger,
  expectNullableNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export type DocumentEmbedProvider =
  "youtube" | "x" | "substack" | "vimeo" | "spotify" | "generic" | "unknown";

export type DocumentEmbedKind =
  "video" | "post" | "audio" | "link_preview" | "unknown";

export type DocumentEmbedUrlStatus = "present" | "absent" | "malformed";

export interface DocumentEmbedUrl {
  status: DocumentEmbedUrlStatus;
  value: string | null;
}

export interface DocumentEmbedLocator {
  canonical_start_offset: number | null;
  canonical_end_offset: number | null;
}

export type DocumentEmbedDisplayMode =
  "resolved" | "pending" | "unsupported" | "failed";

export type DocumentEmbedActionKind =
  "open_child_media" | "open_original" | "retry_child" | "refresh_parent";

export interface DocumentEmbedDisplayAction {
  kind: DocumentEmbedActionKind;
  label: string;
  href?: string | null;
  disabled?: boolean;
}

export interface DocumentEmbedDisplay {
  mode: DocumentEmbedDisplayMode;
  label: string;
  description: string;
  actions: DocumentEmbedDisplayAction[];
}

export type DocumentEmbedTargetStatus =
  | "exact"
  | "container"
  | "missing"
  | "forbidden"
  | "unanchorable"
  | "stale"
  | "unsupported"
  | "partial";

export interface DocumentEmbedTarget {
  status: DocumentEmbedTargetStatus;
  media_id: string | null;
  kind: string | null;
  title: string | null;
  thumbnail_url: string | null;
  playback: MediaPlaybackSource | null;
}

export interface DocumentEmbed {
  id: string;
  media_id: string;
  fragment_id: string | null;
  ordinal: number;
  occurrence_key: string;
  provider: DocumentEmbedProvider;
  kind: DocumentEmbedKind;
  source_url: DocumentEmbedUrl;
  canonical_url: DocumentEmbedUrl;
  locator: DocumentEmbedLocator;
  display: DocumentEmbedDisplay;
  target: DocumentEmbedTarget;
}

export type DocumentEmbedAggregateStatus =
  "unsupported" | "empty" | "resolving" | "ready" | "partial" | "failed";

export interface DocumentEmbedSummary {
  status: DocumentEmbedAggregateStatus;
}

interface DocumentEmbedClassNames {
  card: string;
  media: string;
  thumbnail: string;
  body: string;
  meta: string;
  provider: string;
  state: string;
  title: string;
  description: string;
  actions: string;
  action: string;
  actionDisabled: string;
}

export function decodeDocumentEmbeds(
  raw: unknown,
  name = "DocumentEmbeds",
): DocumentEmbed[] {
  return expectArray(
    raw,
    (embed, index) => decodeDocumentEmbed(embed, `${name}[${index}]`),
    name,
  );
}

export function decodeDocumentEmbed(
  raw: unknown,
  name = "DocumentEmbed",
): DocumentEmbed {
  const value = expectExactRecord(
    raw,
    [
      "id",
      "media_id",
      "fragment_id",
      "occurrence_key",
      "ordinal",
      "provider",
      "kind",
      "source_shape",
      "resolution_status",
      "source_url",
      "canonical_url",
      "provider_target_ref",
      "title",
      "description",
      "thumbnail_url",
      "authored_text",
      "locator",
      "target",
      "error_code",
      "display",
    ],
    name,
  );
  const sourceUrl = decodeUrl(value.source_url, `${name}.source_url`);
  const canonicalUrl = decodeUrl(value.canonical_url, `${name}.canonical_url`);
  decodeProviderRef(value.provider_target_ref, `${name}.provider_target_ref`);
  decodeText(value.title, `${name}.title`);
  decodeText(value.description, `${name}.description`);
  decodeUrl(value.thumbnail_url, `${name}.thumbnail_url`);
  decodeText(value.authored_text, `${name}.authored_text`);
  decodeText(value.error_code, `${name}.error_code`);
  expectOneOf(
    value.source_shape,
    [
      "iframe",
      "blockquote",
      "anchor",
      "video_tag",
      "provider_json",
      "unknown",
    ] as const,
    `${name}.source_shape`,
  );
  expectOneOf(
    value.resolution_status,
    ["pending", "resolving", "resolved", "unsupported", "failed"] as const,
    `${name}.resolution_status`,
  );

  return {
    id: expectString(value.id, `${name}.id`),
    media_id: expectString(value.media_id, `${name}.media_id`),
    fragment_id: expectNullableString(value.fragment_id, `${name}.fragment_id`),
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    occurrence_key: expectString(
      value.occurrence_key,
      `${name}.occurrence_key`,
    ),
    provider: expectOneOf(
      value.provider,
      [
        "youtube",
        "x",
        "substack",
        "vimeo",
        "spotify",
        "generic",
        "unknown",
      ] as const,
      `${name}.provider`,
    ),
    kind: expectOneOf(
      value.kind,
      ["video", "post", "audio", "link_preview", "unknown"] as const,
      `${name}.kind`,
    ),
    source_url: sourceUrl,
    canonical_url: canonicalUrl,
    locator: decodeLocator(value.locator, `${name}.locator`),
    display: decodeDisplay(value.display, `${name}.display`),
    target: decodeTarget(value.target, `${name}.target`),
  };
}

function decodeUrl(raw: unknown, name: string): DocumentEmbedUrl {
  const value = expectExactRecord(
    raw,
    ["status", "value", "error_code", "reason"],
    name,
  );
  expectNullableString(value.error_code, `${name}.error_code`);
  if (value.reason !== null) {
    expectOneOf(
      value.reason,
      ["not_in_source", "not_applicable"] as const,
      `${name}.reason`,
    );
  }
  return {
    status: expectOneOf(
      value.status,
      ["present", "malformed", "absent"] as const,
      `${name}.status`,
    ),
    value: expectNullableString(value.value, `${name}.value`),
  };
}

function decodeProviderRef(raw: unknown, name: string): void {
  const value = expectExactRecord(raw, ["kind", "value", "reason"], name);
  expectOneOf(value.kind, ["present", "absent"] as const, `${name}.kind`);
  expectNullableString(value.value, `${name}.value`);
  if (value.reason !== null) {
    expectOneOf(
      value.reason,
      ["unsupported_provider", "unparseable", "not_applicable"] as const,
      `${name}.reason`,
    );
  }
}

function decodeText(raw: unknown, name: string): void {
  const value = expectExactRecord(raw, ["kind", "value", "reason"], name);
  expectOneOf(value.kind, ["present", "absent"] as const, `${name}.kind`);
  expectNullableString(value.value, `${name}.value`);
  if (value.reason !== null) {
    expectOneOf(
      value.reason,
      ["not_in_source", "redacted", "not_applicable"] as const,
      `${name}.reason`,
    );
  }
}

function decodeLocator(raw: unknown, name: string): DocumentEmbedLocator {
  const value = expectExactRecord(
    raw,
    [
      "kind",
      "fragment_id",
      "canonical_start_offset",
      "canonical_end_offset",
      "document_order_key",
      "placeholder_text",
    ],
    name,
  );
  expectOneOf(value.kind, ["anchored", "unanchored"] as const, `${name}.kind`);
  expectNullableString(value.fragment_id, `${name}.fragment_id`);
  expectString(value.document_order_key, `${name}.document_order_key`);
  expectString(value.placeholder_text, `${name}.placeholder_text`);
  return {
    canonical_start_offset: expectNullableNonnegativeInteger(
      value.canonical_start_offset,
      `${name}.canonical_start_offset`,
    ),
    canonical_end_offset: expectNullableNonnegativeInteger(
      value.canonical_end_offset,
      `${name}.canonical_end_offset`,
    ),
  };
}

function decodeDisplay(raw: unknown, name: string): DocumentEmbedDisplay {
  const value = expectExactRecord(
    raw,
    ["mode", "label", "description", "actions"],
    name,
  );
  return {
    mode: expectOneOf(
      value.mode,
      ["resolved", "pending", "unsupported", "failed"] as const,
      `${name}.mode`,
    ),
    label: expectString(value.label, `${name}.label`),
    description: expectString(value.description, `${name}.description`),
    actions: expectArray(
      value.actions,
      (action, index) =>
        decodeDisplayAction(action, `${name}.actions[${index}]`),
      `${name}.actions`,
    ),
  };
}

function decodeDisplayAction(
  raw: unknown,
  name: string,
): DocumentEmbedDisplayAction {
  const value = expectExactRecord(
    raw,
    ["kind", "label", "href", "disabled"],
    name,
  );
  return {
    kind: expectOneOf(
      value.kind,
      [
        "open_child_media",
        "open_original",
        "retry_child",
        "refresh_parent",
      ] as const,
      `${name}.kind`,
    ),
    label: expectString(value.label, `${name}.label`),
    href: expectNullableString(value.href, `${name}.href`),
    disabled: expectBoolean(value.disabled, `${name}.disabled`),
  };
}

function decodeTarget(raw: unknown, name: string): DocumentEmbedTarget {
  const value = expectExactRecord(
    raw,
    [
      "status",
      "media_id",
      "resource_ref",
      "href",
      "kind",
      "title",
      "thumbnail_url",
      "playback",
    ],
    name,
  );
  expectNullableString(value.resource_ref, `${name}.resource_ref`);
  expectNullableString(value.href, `${name}.href`);
  return {
    status: expectOneOf(
      value.status,
      [
        "exact",
        "container",
        "missing",
        "forbidden",
        "unanchorable",
        "stale",
        "unsupported",
        "partial",
      ] as const,
      `${name}.status`,
    ),
    media_id: expectNullableString(value.media_id, `${name}.media_id`),
    kind: expectNullableString(value.kind, `${name}.kind`),
    title: expectNullableString(value.title, `${name}.title`),
    thumbnail_url: expectNullableString(
      value.thumbnail_url,
      `${name}.thumbnail_url`,
    ),
    playback:
      value.playback === null
        ? null
        : decodePlaybackSource(value.playback, `${name}.playback`),
  };
}

function decodePlaybackSource(raw: unknown, name: string): MediaPlaybackSource {
  const value = expectExactRecord(
    raw,
    [
      "kind",
      "stream_url",
      "source_url",
      "provider",
      "provider_video_id",
      "watch_url",
      "embed_url",
    ],
    name,
  );
  return {
    kind: expectOneOf(
      value.kind,
      ["external_audio", "external_video"] as const,
      `${name}.kind`,
    ),
    stream_url: expectString(value.stream_url, `${name}.stream_url`),
    source_url: expectString(value.source_url, `${name}.source_url`),
    provider: expectNullableString(value.provider, `${name}.provider`),
    provider_video_id: expectNullableString(
      value.provider_video_id,
      `${name}.provider_video_id`,
    ),
    watch_url: expectNullableString(value.watch_url, `${name}.watch_url`),
    embed_url: expectNullableString(value.embed_url, `${name}.embed_url`),
  };
}

export function normalizeDocumentEmbeds(
  embeds: readonly DocumentEmbed[],
): DocumentEmbed[] {
  return [...embeds].sort((left, right) => {
    const ordinalDiff = left.ordinal - right.ordinal;
    return ordinalDiff === 0 ? left.id.localeCompare(right.id) : ordinalDiff;
  });
}

export function renderDocumentEmbedsInHtml(
  html: string,
  embeds: readonly DocumentEmbed[],
  classNames: DocumentEmbedClassNames,
): string {
  if (embeds.length === 0 || typeof DOMParser === "undefined") {
    return html;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = document.body.firstElementChild;
  if (!root) {
    return html;
  }

  for (const embed of normalizeDocumentEmbeds(embeds)) {
    const card = buildDocumentEmbedCard(document, embed, classNames);
    const placeholder = findDocumentEmbedPlaceholder(
      root,
      embed.occurrence_key,
    );
    if (placeholder) {
      placeholder.replaceWith(card);
    }
  }

  return root.innerHTML;
}

function findDocumentEmbedPlaceholder(
  root: Element,
  embedId: string,
): Element | null {
  for (const candidate of root.querySelectorAll(
    "[data-nexus-document-embed-id]",
  )) {
    if (candidate.getAttribute("data-nexus-document-embed-id") === embedId) {
      return candidate;
    }
  }
  return null;
}

function buildDocumentEmbedCard(
  document: Document,
  embed: DocumentEmbed,
  classNames: DocumentEmbedClassNames,
): HTMLElement {
  const card = document.createElement("figure");
  card.className = classNames.card;
  card.setAttribute("data-nexus-document-embed-id", embed.occurrence_key);
  card.setAttribute("data-document-embed-state", embed.display.mode);
  card.setAttribute("data-document-embed-provider", embed.provider);
  card.setAttribute("data-document-embed-kind", embed.kind);
  card.setAttribute(
    "aria-label",
    `${embed.display.label}: ${embed.display.description}`,
  );

  const thumbnailUrl = normalizedHttpOrRelativeUrl(embed.target.thumbnail_url);
  if (thumbnailUrl) {
    const media = document.createElement("div");
    media.className = classNames.media;
    const image = document.createElement("img");
    image.className = classNames.thumbnail;
    image.src = thumbnailUrl;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    media.append(image);
    card.append(media);
  }

  const body = document.createElement("figcaption");
  body.className = classNames.body;

  const meta = document.createElement("div");
  meta.className = classNames.meta;

  const provider = document.createElement("span");
  provider.className = classNames.provider;
  provider.textContent = formatDocumentEmbedProvider(embed.provider);
  meta.append(provider);

  const state = document.createElement("span");
  state.className = classNames.state;
  state.textContent = formatDocumentEmbedState(embed.display.mode);
  meta.append(state);
  body.append(meta);

  const title = document.createElement("strong");
  title.className = classNames.title;
  title.textContent = embed.display.label;
  body.append(title);

  const description = document.createElement("p");
  description.className = classNames.description;
  description.textContent =
    embed.target.title?.trim() || embed.display.description;
  body.append(description);

  if (embed.target.title?.trim() && embed.display.description.trim()) {
    const detail = document.createElement("p");
    detail.className = classNames.description;
    detail.textContent = embed.display.description;
    body.append(detail);
  }

  const actions = buildDocumentEmbedActions(document, embed, classNames);
  if (actions) {
    body.append(actions);
  }

  card.append(body);
  return card;
}

function buildDocumentEmbedActions(
  document: Document,
  embed: DocumentEmbed,
  classNames: DocumentEmbedClassNames,
): HTMLElement | null {
  const actions = document.createElement("div");
  actions.className = classNames.actions;

  for (const action of embed.display.actions) {
    const href = documentEmbedActionHref(embed, action);
    if (action.disabled || !href) {
      const disabled = document.createElement("span");
      disabled.className = `${classNames.action} ${classNames.actionDisabled}`;
      disabled.textContent = action.label;
      disabled.setAttribute("aria-disabled", "true");
      actions.append(disabled);
      continue;
    }

    const link = document.createElement("a");
    link.className = classNames.action;
    link.href = href;
    link.textContent = action.label;
    if (isExternalHref(href)) {
      link.target = "_blank";
      link.rel = "noreferrer";
    }
    actions.append(link);
  }

  return actions.childElementCount > 0 ? actions : null;
}

function documentEmbedActionHref(
  embed: DocumentEmbed,
  action: DocumentEmbedDisplayAction,
): string | null {
  const explicitHref = normalizedHttpOrRelativeUrl(action.href ?? null);
  if (explicitHref) {
    return explicitHref;
  }

  switch (action.kind) {
    case "open_child_media":
      return embed.target.media_id ? `/media/${embed.target.media_id}` : null;
    case "open_original":
      return (
        normalizedHttpOrRelativeUrl(embed.canonical_url.value) ??
        normalizedHttpOrRelativeUrl(embed.source_url.value)
      );
    case "retry_child":
    case "refresh_parent":
      return null;
  }
}

function normalizedHttpOrRelativeUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isExternalHref(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://");
}

function formatDocumentEmbedState(state: DocumentEmbedDisplayMode): string {
  switch (state) {
    case "resolved":
      return "Resolved";
    case "pending":
      return "Pending";
    case "unsupported":
      return "Unsupported";
    case "failed":
      return "Failed";
  }
}

function formatDocumentEmbedProvider(provider: DocumentEmbedProvider): string {
  switch (provider) {
    case "youtube":
      return "YouTube";
    case "x":
      return "X";
    case "substack":
      return "Substack";
    case "vimeo":
      return "Vimeo";
    case "spotify":
      return "Spotify";
    case "generic":
      return "Embedded content";
    case "unknown":
      return "Unknown provider";
  }
}
