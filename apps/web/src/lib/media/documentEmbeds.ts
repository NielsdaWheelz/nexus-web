import type { MediaPlaybackSource } from "@/lib/media/playback";

export type DocumentEmbedProvider =
  | "youtube"
  | "x"
  | "substack"
  | "vimeo"
  | "spotify"
  | "generic"
  | "unknown";

export type DocumentEmbedKind =
  | "video"
  | "post"
  | "audio"
  | "link_preview"
  | "unknown";

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
  | "resolved"
  | "pending"
  | "unsupported"
  | "failed";

export type DocumentEmbedActionKind =
  | "open_child_media"
  | "open_original"
  | "retry_child"
  | "refresh_parent";

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
  | "partial"
  | "pending"
  | "resolved"
  | "failed";

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
  fragment_id: string;
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
  | "unsupported"
  | "empty"
  | "resolving"
  | "ready"
  | "partial"
  | "failed";

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
    const placeholder = findDocumentEmbedPlaceholder(root, embed.occurrence_key);
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
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
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
