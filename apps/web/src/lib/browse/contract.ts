import { asRecord, exactKeys } from "@/lib/api/exact";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  decodePublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import type { ApiError } from "@/lib/api/client";
import {
  parseMediaImageProxySrc,
  type MediaImageProxySrc,
} from "@/lib/media/imageProxy";

declare const DISCOVERY_TARGET_HANDLE: unique symbol;

/** Signed Browse identity. Integrity is server-owned; the client never parses it. */
export type DiscoveryTargetHandle = string & {
  readonly [DISCOVERY_TARGET_HANDLE]: true;
};

export type BrowseKind = "Pdf" | "Epub" | "WebArticle" | "Video" | "Podcast";
export type BrowseSource =
  "Nexus" | "ProjectGutenberg" | "Brave" | "YouTube" | "PodcastIndex";
export type BrowseSort = "Relevance" | "Newest";

export type BrowseResolution =
  | { readonly kind: "InNexus"; readonly href: string }
  | { readonly kind: "Preview"; readonly target: DiscoveryTargetHandle }
  | { readonly kind: "ExternalOnly"; readonly sourceHref: string };

interface BrowseCandidateBase<
  Kind extends BrowseKind,
  Source extends BrowseSource,
  Facts,
> {
  readonly kind: Kind;
  readonly source: Source;
  readonly resolution: BrowseResolution;
  readonly title: string;
  readonly contributors: readonly ContributorCredit[];
  readonly description: Presence<string>;
  readonly publishedAt: Presence<PublicationDate>;
  /** Already-proxied same-origin image URL. */
  readonly image: Presence<MediaImageProxySrc>;
  readonly kindFacts: Facts;
}

export type BrowseCandidate =
  | BrowseCandidateBase<
      "Pdf",
      "Nexus",
      { readonly pageCount: Presence<number> }
    >
  | BrowseCandidateBase<
      "Epub",
      "Nexus" | "ProjectGutenberg",
      { readonly ebookRef: Presence<string> }
    >
  | BrowseCandidateBase<
      "WebArticle",
      "Nexus" | "Brave",
      { readonly siteName: Presence<string> }
    >
  | BrowseCandidateBase<
      "Video",
      "Nexus" | "YouTube",
      {
        readonly videoRef: Presence<string>;
        readonly channelTitle: Presence<string>;
      }
    >
  | BrowseCandidateBase<
      "Podcast",
      "PodcastIndex",
      { readonly podcastRef: string }
    >;

export interface BrowsePage {
  readonly query: string;
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: Presence<BrowseSort>;
  readonly items: readonly BrowseCandidate[];
  readonly nextCursor: Presence<string>;
}

export type BrowseSectionFailure =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "RateLimited";
      readonly retryAt: Presence<PublicationDate>;
    }
  | {
      readonly kind: "QuotaExhausted";
      readonly resetAt: Presence<PublicationDate>;
    };

export interface PreviewEpisodeFacts {
  readonly podcastRef: string;
  readonly episodeRef: string;
  readonly podcastTitle: string;
  readonly audioHref: string;
  readonly durationSeconds: Presence<number>;
}

export interface PreviewEpisodeItem {
  readonly target: DiscoveryTargetHandle;
  readonly title: string;
  readonly contributors: readonly ContributorCredit[];
  readonly description: Presence<string>;
  readonly publishedAt: Presence<PublicationDate>;
  readonly image: Presence<MediaImageProxySrc>;
  readonly kindFacts: PreviewEpisodeFacts;
}

export interface PreviewEpisodePage {
  readonly items: readonly PreviewEpisodeItem[];
  readonly nextCursor: Presence<string>;
}

interface BrowsePreviewBase<
  Kind extends "Epub" | "WebArticle" | "Video" | "Podcast" | "Episode",
  Source extends BrowseSource,
  Facts,
> {
  readonly kind: Kind;
  readonly source: Source;
  readonly target: DiscoveryTargetHandle;
  readonly title: string;
  readonly contributors: readonly ContributorCredit[];
  readonly description: Presence<string>;
  readonly publishedAt: Presence<PublicationDate>;
  readonly image: Presence<MediaImageProxySrc>;
  readonly sourceHref: string;
  readonly resolution: Exclude<BrowseResolution, { kind: "ExternalOnly" }>;
  readonly kindFacts: Facts;
}

export type BrowsePreview =
  | BrowsePreviewBase<
      "Epub",
      "ProjectGutenberg",
      { readonly ebookRef: string; readonly importHref: string }
    >
  | BrowsePreviewBase<
      "WebArticle",
      "Brave",
      {
        readonly canonicalUrl: string;
        readonly siteName: Presence<string>;
      }
    >
  | BrowsePreviewBase<
      "Video",
      "YouTube",
      {
        readonly videoRef: string;
        readonly channelTitle: Presence<string>;
        readonly embedHref: string;
      }
    >
  | (BrowsePreviewBase<
      "Podcast",
      "PodcastIndex",
      {
        readonly podcastRef: string;
        readonly feedHref: string;
        readonly websiteHref: Presence<string>;
      }
    > & { readonly episodes: PreviewEpisodePage })
  | BrowsePreviewBase<"Episode", "PodcastIndex", PreviewEpisodeFacts>;

/**
 * The only player-facing shape owned by Browse Preview. It contains no Media
 * identity because Preview playback is deliberately non-acquiring.
 */
export interface PreviewAudioDescriptor {
  readonly target: DiscoveryTargetHandle;
  readonly previewHref: string;
  readonly title: string;
  readonly source: string;
  readonly sourceHref: string;
  readonly audioUrl: string;
  readonly imageUrl: Presence<MediaImageProxySrc>;
  readonly durationMs: Presence<number>;
}

export function decodePreviewAudioDescriptor(
  raw: unknown,
): PreviewAudioDescriptor {
  const value = asRecord(raw, "PreviewAudioDescriptor");
  exactKeys(
    value,
    [
      "target",
      "previewHref",
      "title",
      "source",
      "sourceHref",
      "audioUrl",
      "imageUrl",
      "durationMs",
    ],
    "PreviewAudioDescriptor",
  );
  return {
    target: parseDiscoveryTargetHandle(value.target),
    previewHref: internalHref(
      value.previewHref,
      "PreviewAudioDescriptor.previewHref",
    ),
    title: string(value.title, "PreviewAudioDescriptor.title"),
    source: string(value.source, "PreviewAudioDescriptor.source"),
    sourceHref: string(value.sourceHref, "PreviewAudioDescriptor.sourceHref"),
    audioUrl: string(value.audioUrl, "PreviewAudioDescriptor.audioUrl"),
    imageUrl: decodePresence(value.imageUrl, (imageUrl) =>
      proxiedImageHref(imageUrl, "PreviewAudioDescriptor.imageUrl.value"),
    ),
    durationMs: decodePresence(value.durationMs, (durationMs) =>
      nonnegativeInteger(
        durationMs,
        "PreviewAudioDescriptor.durationMs.value",
      ),
    ),
  };
}

export function assumeDiscoveryTargetHandle(
  value: string,
): DiscoveryTargetHandle {
  return parseDiscoveryTargetHandle(value);
}

function decodeCanonicalBase64Url(value: string, context: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${context} must be unpadded base64url`);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new TypeError(`${context} must be unpadded base64url`);
  }
  const encoded = btoa(decoded)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (encoded !== value) {
    throw new TypeError(`${context} must be canonical base64url`);
  }
  return decoded;
}

export function parseDiscoveryTargetHandle(
  value: unknown,
): DiscoveryTargetHandle {
  if (typeof value !== "string") {
    throw new TypeError("DiscoveryTargetHandle must be a string");
  }
  const match = /^ndt1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match) {
    throw new TypeError("DiscoveryTargetHandle has invalid grammar");
  }
  const payload = decodeCanonicalBase64Url(
    match[1]!,
    "DiscoveryTargetHandle payload",
  );
  const tag = decodeCanonicalBase64Url(match[2]!, "DiscoveryTargetHandle tag");
  if (payload.length === 0 || payload.length > 4096 || tag.length !== 32) {
    throw new TypeError("DiscoveryTargetHandle has invalid bounds");
  }
  return value as DiscoveryTargetHandle;
}

export function browsePreviewHref(target: DiscoveryTargetHandle): string {
  return `/browse/preview?target=${encodeURIComponent(target)}`;
}

const BROWSE_KINDS: readonly BrowseKind[] = [
  "Pdf",
  "Epub",
  "WebArticle",
  "Video",
  "Podcast",
];
const BROWSE_SOURCES: readonly BrowseSource[] = [
  "Nexus",
  "ProjectGutenberg",
  "Brave",
  "YouTube",
  "PodcastIndex",
];

function string(raw: unknown, context: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return raw;
}

function stringValue(raw: unknown, context: string): string {
  if (typeof raw !== "string") {
    throw new TypeError(`${context} must be a string`);
  }
  return raw;
}

function literal<T extends string>(
  raw: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) {
    throw new TypeError(`${context} has an unsupported value`);
  }
  return raw as T;
}

function nonnegativeInteger(raw: unknown, context: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`${context} must be a nonnegative integer`);
  }
  return raw;
}

function positiveNumber(raw: unknown, context: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TypeError(`${context} must be a positive number`);
  }
  return raw;
}

function externalHref(raw: unknown, context: string): string {
  const value = string(raw, context);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${context} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${context} must use HTTP or HTTPS`);
  }
  return value;
}

function httpsHref(raw: unknown, context: string): string {
  const value = externalHref(raw, context);
  if (new URL(value).protocol !== "https:") {
    throw new TypeError(`${context} must use HTTPS`);
  }
  return value;
}

function internalHref(raw: unknown, context: string): string {
  const value = string(raw, context);
  if (normalizeWorkspaceHref(value) !== value) {
    throw new TypeError(`${context} must be a canonical internal href`);
  }
  return value;
}

function proxiedImageHref(raw: unknown, context: string): MediaImageProxySrc {
  const value = string(raw, context);
  try {
    return parseMediaImageProxySrc(value);
  } catch {
    throw new TypeError(`${context} must use the image proxy`);
  }
}

function decodeContributors(
  raw: unknown,
  context: string,
): readonly ContributorCredit[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`${context} must be an array`);
  }
  return raw.map((credit, index) =>
    decodeContributorCredit(credit, index, context),
  );
}

function decodeResolution(raw: unknown, context: string): BrowseResolution {
  const value = asRecord(raw, context);
  switch (value.kind) {
    case "InNexus":
      exactKeys(value, ["kind", "href"], context);
      return {
        kind: "InNexus",
        href: internalHref(value.href, `${context}.href`),
      };
    case "Preview":
      exactKeys(value, ["kind", "target"], context);
      return {
        kind: "Preview",
        target: assumeDiscoveryTargetHandle(
          string(value.target, `${context}.target`),
        ),
      };
    case "ExternalOnly":
      exactKeys(value, ["kind", "sourceHref"], context);
      return {
        kind: "ExternalOnly",
        sourceHref: externalHref(value.sourceHref, `${context}.sourceHref`),
      };
    default:
      throw new TypeError(`${context}.kind has an unsupported value`);
  }
}

function decodeCommon(value: Record<string, unknown>, context: string) {
  return {
    title: string(value.title, `${context}.title`),
    contributors: decodeContributors(
      value.contributors,
      `${context}.contributors`,
    ),
    description: decodePresence(value.description, (raw) =>
      stringValue(raw, `${context}.description.value`),
    ),
    publishedAt: decodePresence(value.publishedAt, (raw) =>
      decodePublicationDate(raw, `${context}.publishedAt.value`),
    ),
    image: decodePresence(value.image, (raw) =>
      proxiedImageHref(raw, `${context}.image.value`),
    ),
  };
}

function decodeCandidate(raw: unknown, index: number): BrowseCandidate {
  const context = `BrowsePage.items[${index}]`;
  const value = asRecord(raw, context);
  exactKeys(
    value,
    [
      "kind",
      "source",
      "resolution",
      "title",
      "contributors",
      "description",
      "publishedAt",
      "image",
      "kindFacts",
    ],
    context,
  );
  const kind = literal(value.kind, BROWSE_KINDS, `${context}.kind`);
  const source = literal(value.source, BROWSE_SOURCES, `${context}.source`);
  const common = decodeCommon(value, context);
  const resolution = decodeResolution(
    value.resolution,
    `${context}.resolution`,
  );
  const facts = asRecord(value.kindFacts, `${context}.kindFacts`);
  switch (kind) {
    case "Pdf":
      if (source !== "Nexus")
        throw new TypeError(`${context}.source is invalid`);
      exactKeys(facts, ["pageCount"], `${context}.kindFacts`);
      return {
        kind,
        source,
        resolution,
        ...common,
        kindFacts: {
          pageCount: decodePresence(facts.pageCount, (raw) =>
            nonnegativeInteger(raw, `${context}.kindFacts.pageCount.value`),
          ),
        },
      };
    case "Epub":
      if (source !== "Nexus" && source !== "ProjectGutenberg") {
        throw new TypeError(`${context}.source is invalid`);
      }
      exactKeys(facts, ["ebookRef"], `${context}.kindFacts`);
      return {
        kind,
        source,
        resolution,
        ...common,
        kindFacts: {
          ebookRef: decodePresence(facts.ebookRef, (raw) =>
            string(raw, `${context}.kindFacts.ebookRef.value`),
          ),
        },
      };
    case "WebArticle":
      if (source !== "Nexus" && source !== "Brave") {
        throw new TypeError(`${context}.source is invalid`);
      }
      exactKeys(facts, ["siteName"], `${context}.kindFacts`);
      return {
        kind,
        source,
        resolution,
        ...common,
        kindFacts: {
          siteName: decodePresence(facts.siteName, (raw) =>
            string(raw, `${context}.kindFacts.siteName.value`),
          ),
        },
      };
    case "Video":
      if (source !== "Nexus" && source !== "YouTube") {
        throw new TypeError(`${context}.source is invalid`);
      }
      exactKeys(facts, ["videoRef", "channelTitle"], `${context}.kindFacts`);
      return {
        kind,
        source,
        resolution,
        ...common,
        kindFacts: {
          videoRef: decodePresence(facts.videoRef, (raw) =>
            string(raw, `${context}.kindFacts.videoRef.value`),
          ),
          channelTitle: decodePresence(facts.channelTitle, (raw) =>
            string(raw, `${context}.kindFacts.channelTitle.value`),
          ),
        },
      };
    case "Podcast":
      if (source !== "PodcastIndex") {
        throw new TypeError(`${context}.source is invalid`);
      }
      exactKeys(facts, ["podcastRef"], `${context}.kindFacts`);
      return {
        kind,
        source,
        resolution,
        ...common,
        kindFacts: {
          podcastRef: string(
            facts.podcastRef,
            `${context}.kindFacts.podcastRef`,
          ),
        },
      };
  }
}

export function decodeBrowsePage(raw: unknown): BrowsePage {
  const value = asRecord(raw, "BrowsePage");
  exactKeys(
    value,
    ["query", "kind", "source", "sort", "items", "nextCursor"],
    "BrowsePage",
  );
  if (!Array.isArray(value.items)) {
    throw new TypeError("BrowsePage.items must be an array");
  }
  return {
    query: string(value.query, "BrowsePage.query"),
    kind: literal(value.kind, BROWSE_KINDS, "BrowsePage.kind"),
    source: literal(value.source, BROWSE_SOURCES, "BrowsePage.source"),
    sort: decodePresence(value.sort, (raw) =>
      literal(raw, ["Relevance", "Newest"] as const, "BrowsePage.sort.value"),
    ),
    items: value.items.map(decodeCandidate),
    nextCursor: decodePresence(value.nextCursor, (cursor) =>
      string(cursor, "BrowsePage.nextCursor.value"),
    ),
  };
}

export function decodeBrowsePageEnvelope(raw: unknown): BrowsePage {
  const envelope = asRecord(raw, "BrowsePage envelope");
  exactKeys(envelope, ["data"], "BrowsePage envelope");
  return decodeBrowsePage(envelope.data);
}

export function decodeBrowseSectionFailure(
  error: ApiError,
): BrowseSectionFailure {
  const details = asRecord(error.details, "BrowseSectionFailure");
  switch (error.code) {
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      exactKeys(details, ["kind"], "BrowseSectionFailure.Unavailable");
      if (details.kind !== "Unavailable") {
        throw new TypeError("BrowseSectionFailure.Unavailable.kind is invalid");
      }
      return { kind: "Unavailable" };
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
      exactKeys(
        details,
        ["kind", "retryAt"],
        "BrowseSectionFailure.RateLimited",
      );
      if (details.kind !== "RateLimited") {
        throw new TypeError("BrowseSectionFailure.RateLimited.kind is invalid");
      }
      return {
        kind: "RateLimited",
        retryAt: decodePresence(details.retryAt, (value) =>
          decodePublicationDate(
            value,
            "BrowseSectionFailure.RateLimited.retryAt.value",
          ),
        ),
      };
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      exactKeys(
        details,
        ["kind", "resetAt"],
        "BrowseSectionFailure.QuotaExhausted",
      );
      if (details.kind !== "QuotaExhausted") {
        throw new TypeError(
          "BrowseSectionFailure.QuotaExhausted.kind is invalid",
        );
      }
      return {
        kind: "QuotaExhausted",
        resetAt: decodePresence(details.resetAt, (value) =>
          decodePublicationDate(
            value,
            "BrowseSectionFailure.QuotaExhausted.resetAt.value",
          ),
        ),
      };
    default:
      throw error;
  }
}

function decodePreviewEpisodeFacts(
  raw: unknown,
  context: string,
): PreviewEpisodeFacts {
  const value = asRecord(raw, context);
  exactKeys(
    value,
    [
      "podcastRef",
      "episodeRef",
      "podcastTitle",
      "audioHref",
      "durationSeconds",
    ],
    context,
  );
  return {
    podcastRef: string(value.podcastRef, `${context}.podcastRef`),
    episodeRef: string(value.episodeRef, `${context}.episodeRef`),
    podcastTitle: string(value.podcastTitle, `${context}.podcastTitle`),
    audioHref: httpsHref(value.audioHref, `${context}.audioHref`),
    durationSeconds: decodePresence(value.durationSeconds, (duration) =>
      positiveNumber(duration, `${context}.durationSeconds.value`),
    ),
  };
}

function decodePreviewEpisodeItem(
  raw: unknown,
  index: number,
): PreviewEpisodeItem {
  const context = `PreviewEpisodePage.items[${index}]`;
  const value = asRecord(raw, context);
  exactKeys(
    value,
    [
      "target",
      "title",
      "contributors",
      "description",
      "publishedAt",
      "image",
      "kindFacts",
    ],
    context,
  );
  return {
    target: assumeDiscoveryTargetHandle(
      string(value.target, `${context}.target`),
    ),
    ...decodeCommon(value, context),
    kindFacts: decodePreviewEpisodeFacts(
      value.kindFacts,
      `${context}.kindFacts`,
    ),
  };
}

function decodePreviewEpisodePage(raw: unknown): PreviewEpisodePage {
  const value = asRecord(raw, "PreviewEpisodePage");
  exactKeys(value, ["items", "nextCursor"], "PreviewEpisodePage");
  if (!Array.isArray(value.items)) {
    throw new TypeError("PreviewEpisodePage.items must be an array");
  }
  return {
    items: value.items.map(decodePreviewEpisodeItem),
    nextCursor: decodePresence(value.nextCursor, (cursor) =>
      string(cursor, "PreviewEpisodePage.nextCursor.value"),
    ),
  };
}

export function decodeBrowsePreview(raw: unknown): BrowsePreview {
  const value = asRecord(raw, "BrowsePreview");
  const kind = literal(
    value.kind,
    ["Epub", "WebArticle", "Video", "Podcast", "Episode"] as const,
    "BrowsePreview.kind",
  );
  exactKeys(
    value,
    kind === "Podcast"
      ? [
          "kind",
          "source",
          "target",
          "title",
          "contributors",
          "description",
          "publishedAt",
          "image",
          "sourceHref",
          "resolution",
          "kindFacts",
          "episodes",
        ]
      : [
          "kind",
          "source",
          "target",
          "title",
          "contributors",
          "description",
          "publishedAt",
          "image",
          "sourceHref",
          "resolution",
          "kindFacts",
        ],
    "BrowsePreview",
  );
  const source = literal(value.source, BROWSE_SOURCES, "BrowsePreview.source");
  const target = assumeDiscoveryTargetHandle(
    string(value.target, "BrowsePreview.target"),
  );
  const resolution = decodeResolution(
    value.resolution,
    "BrowsePreview.resolution",
  );
  if (resolution.kind === "ExternalOnly") {
    throw new TypeError("BrowsePreview.resolution cannot be ExternalOnly");
  }
  const common = {
    target,
    ...decodeCommon(value, "BrowsePreview"),
    sourceHref: externalHref(value.sourceHref, "BrowsePreview.sourceHref"),
    resolution,
  };
  const facts = asRecord(value.kindFacts, "BrowsePreview.kindFacts");
  switch (kind) {
    case "Epub":
      if (source !== "ProjectGutenberg") {
        throw new TypeError("BrowsePreview.source is invalid");
      }
      exactKeys(facts, ["ebookRef", "importHref"], "BrowsePreview.kindFacts");
      return {
        kind,
        source,
        ...common,
        kindFacts: {
          ebookRef: string(facts.ebookRef, "BrowsePreview.kindFacts.ebookRef"),
          importHref: externalHref(
            facts.importHref,
            "BrowsePreview.kindFacts.importHref",
          ),
        },
      };
    case "WebArticle":
      if (source !== "Brave") {
        throw new TypeError("BrowsePreview.source is invalid");
      }
      exactKeys(facts, ["canonicalUrl", "siteName"], "BrowsePreview.kindFacts");
      return {
        kind,
        source,
        ...common,
        kindFacts: {
          canonicalUrl: externalHref(
            facts.canonicalUrl,
            "BrowsePreview.kindFacts.canonicalUrl",
          ),
          siteName: decodePresence(facts.siteName, (site) =>
            string(site, "BrowsePreview.kindFacts.siteName.value"),
          ),
        },
      };
    case "Video":
      if (source !== "YouTube") {
        throw new TypeError("BrowsePreview.source is invalid");
      }
      exactKeys(
        facts,
        ["videoRef", "channelTitle", "embedHref"],
        "BrowsePreview.kindFacts",
      );
      return {
        kind,
        source,
        ...common,
        kindFacts: {
          videoRef: string(facts.videoRef, "BrowsePreview.kindFacts.videoRef"),
          channelTitle: decodePresence(facts.channelTitle, (channel) =>
            string(channel, "BrowsePreview.kindFacts.channelTitle.value"),
          ),
          embedHref: externalHref(
            facts.embedHref,
            "BrowsePreview.kindFacts.embedHref",
          ),
        },
      };
    case "Podcast":
      if (source !== "PodcastIndex") {
        throw new TypeError("BrowsePreview.source is invalid");
      }
      exactKeys(
        facts,
        ["podcastRef", "feedHref", "websiteHref"],
        "BrowsePreview.kindFacts",
      );
      return {
        kind,
        source,
        ...common,
        kindFacts: {
          podcastRef: string(
            facts.podcastRef,
            "BrowsePreview.kindFacts.podcastRef",
          ),
          feedHref: externalHref(
            facts.feedHref,
            "BrowsePreview.kindFacts.feedHref",
          ),
          websiteHref: decodePresence(facts.websiteHref, (website) =>
            externalHref(website, "BrowsePreview.kindFacts.websiteHref.value"),
          ),
        },
        episodes: decodePreviewEpisodePage(value.episodes),
      };
    case "Episode":
      if (source !== "PodcastIndex") {
        throw new TypeError("BrowsePreview.source is invalid");
      }
      return {
        kind,
        source,
        ...common,
        kindFacts: decodePreviewEpisodeFacts(facts, "BrowsePreview.kindFacts"),
      };
  }
}

export function decodeBrowsePreviewEnvelope(raw: unknown): BrowsePreview {
  const envelope = asRecord(raw, "BrowsePreview envelope");
  exactKeys(envelope, ["data"], "BrowsePreview envelope");
  return decodeBrowsePreview(envelope.data);
}
