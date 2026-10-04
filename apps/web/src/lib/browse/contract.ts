import { expectExactRecord, expectIsoInstant, expectRecord } from "@/lib/validation";
import { decodePresence, type Presence } from "@/lib/api/presence";
import type { ApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import {
  parseMediaImageProxySrc,
  type MediaImageProxySrc,
} from "@/lib/media/imageProxy";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

declare const DISCOVERY_TARGET_HANDLE: unique symbol;

/** Signed browse identity. Integrity is server-owned; the client never opens it. */
export type DiscoveryTargetHandle = string & {
  readonly [DISCOVERY_TARGET_HANDLE]: true;
};

export type BrowseKind = Schema<"BrowseKind">;
export type BrowseSource = Schema<"BrowseSource">;
export type BrowseSort = Schema<"BrowseSort">;
export type BrowsePage = ApiJson<"/browse", "get">["data"];
export type BrowseCandidate = BrowsePage["items"][number];
export type BrowsePreview = ApiJson<"/browse/preview", "get">["data"];
export type PreviewEpisodeItem = Schema<"PodcastPreviewEpisode">;

export type BrowseSectionFailure =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "RateLimited"; readonly retryAt: Presence<string> }
  | { readonly kind: "QuotaExhausted"; readonly resetAt: Presence<string> };

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

function string(raw: unknown, context: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return raw;
}

function nonnegativeInteger(raw: unknown, context: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`${context} must be a nonnegative integer`);
  }
  return raw;
}

function internalHref(raw: unknown, context: string): string {
  const value = string(raw, context);
  if (normalizeWorkspaceHref(value) !== value) {
    throw new TypeError(`${context} must be a canonical internal href`);
  }
  return value;
}

export function proxiedImageHref(raw: unknown, context: string): MediaImageProxySrc {
  const value = string(raw, context);
  try {
    return parseMediaImageProxySrc(value);
  } catch {
    throw new TypeError(`${context} must use the image proxy`);
  }
}

export function decodePreviewAudioDescriptor(
  raw: unknown,
): PreviewAudioDescriptor {
  const value = expectExactRecord(
    raw,
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
      nonnegativeInteger(durationMs, "PreviewAudioDescriptor.durationMs.value"),
    ),
  };
}

export function parseDiscoveryTargetHandle(
  value: unknown,
): DiscoveryTargetHandle {
  if (typeof value !== "string") {
    throw new TypeError("DiscoveryTargetHandle must be a string");
  }
  if (!/^ndt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("DiscoveryTargetHandle has invalid grammar");
  }
  return value as DiscoveryTargetHandle;
}

export function browsePreviewHref(target: string): string {
  return `/browse/preview?target=${encodeURIComponent(parseDiscoveryTargetHandle(target))}`;
}

function checkImage(image: Presence<string>, context: string): void {
  if (image.kind === "Present") proxiedImageHref(image.value, context);
}

function checkResolution(resolution: Schema<"BrowseResolution">): void {
  if (resolution.kind === "InNexusMedia") mediaSummaryFromWire(resolution.mediaSummary);
}

/** Only the semantic leaves the backend schema cannot establish are checked here. */
export function checkBrowsePageLeaves(page: BrowsePage): void {
  page.items.forEach((candidate, index) => {
    checkImage(candidate.image, `BrowsePage.items[${index}].image.value`);
    checkResolution(candidate.resolution);
  });
}

export function checkBrowsePreviewLeaves(preview: BrowsePreview): void {
  checkImage(preview.image, "BrowsePreview.image.value");
  checkResolution(preview.resolution);
  if (preview.kind === "Podcast") {
    preview.episodes.items.forEach((episode, index) =>
      checkImage(episode.image, `PreviewEpisodePage.items[${index}].image.value`),
    );
  }
}

export function decodeBrowseSectionFailure(error: ApiError): BrowseSectionFailure {
  const details = expectRecord(error.details, "BrowseSectionFailure");
  switch (error.code) {
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      expectExactRecord(details, ["kind"], "BrowseSectionFailure.Unavailable");
      return { kind: "Unavailable" };
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
      expectExactRecord(
        details,
        ["kind", "retryAt"],
        "BrowseSectionFailure.RateLimited",
      );
      return {
        kind: "RateLimited",
        retryAt: decodePresence(details.retryAt, (value) =>
          expectIsoInstant(
            value,
            "BrowseSectionFailure.RateLimited.retryAt.value",
          ),
        ),
      };
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      expectExactRecord(
        details,
        ["kind", "resetAt"],
        "BrowseSectionFailure.QuotaExhausted",
      );
      return {
        kind: "QuotaExhausted",
        resetAt: decodePresence(details.resetAt, (value) =>
          expectIsoInstant(
            value,
            "BrowseSectionFailure.QuotaExhausted.resetAt.value",
          ),
        ),
      };
    default:
      throw error;
  }
}
