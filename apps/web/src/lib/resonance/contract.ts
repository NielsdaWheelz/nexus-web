/** Strict same-system transport contract for Resonance reading slates. */

import { decodePresence, type Presence } from "@/lib/api/presence";
import { asRecord, exactKeys } from "@/lib/api/exact";
import type { ProgressFraction } from "@/lib/consumption/activityFacts";
import {
  decodePublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import { assumeAppHref, type AppHref } from "@/lib/lectern/contract";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { expectIsoInstant } from "@/lib/validation";

const SLATE_LIMIT = 10;
const MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "video",
  "podcast_episode",
] as const;
const RESONANCE_EDGE_ORIGINS = [
  "user",
  "citation",
  "note_body",
  "highlight_note",
  "document_embed",
  "synapse",
] as const;

export type SlateMediaKind = (typeof MEDIA_KINDS)[number];
export type ResonanceEdgeOrigin = (typeof RESONANCE_EDGE_ORIGINS)[number];
export type ResourceRefUri = string & {
  readonly __resourceRefUri: unique symbol;
};

export interface SlateAnchor {
  ref: ResourceRefUri;
  label: string;
}

interface SlateTargetBase {
  ref: ResourceRefUri;
  title: string;
  subtitle: Presence<string>;
  imageUrl: Presence<string>;
  href: AppHref;
  actionSubject: ResourceActionSubject;
}

export type SlateTarget =
  | (SlateTargetBase & { kind: "Media"; mediaKind: SlateMediaKind })
  | (SlateTargetBase & { kind: "Podcast" });

export type SlateReason =
  | {
      kind: "Continue";
      progress: Presence<ProgressFraction>;
      lastEngagedAt: string;
    }
  | { kind: "AddedToNexus"; addedAt: string }
  | { kind: "Published"; publishedOn: PublicationDate }
  | { kind: "NewEpisode"; publishedAt: PublicationDate }
  | {
      kind: "Connected";
      anchor: SlateAnchor;
      edgeOrigin: ResonanceEdgeOrigin;
    }
  | {
      kind: "SharedAuthor";
      anchor: SlateAnchor;
      authorName: string;
    }
  | { kind: "Similar"; anchor: SlateAnchor };

export interface SlateItem {
  target: SlateTarget;
  reason: SlateReason;
}

export interface SlateSnapshot {
  items: SlateItem[];
}

function asString(raw: unknown, context: string): string {
  if (typeof raw !== "string") {
    throw new Error(`Invalid ${context}: expected a string`);
  }
  return raw;
}

function asLiteral<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (
    typeof raw !== "string" ||
    !(allowed as readonly string[]).includes(raw)
  ) {
    throw new Error(
      `Invalid ${context}: expected one of [${allowed.join(", ")}], got ${JSON.stringify(raw)}`,
    );
  }
  return raw as T;
}

function asFraction(raw: unknown, context: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`Invalid ${context}: expected a finite number in 0..1`);
  }
  return raw;
}

function decodeResourceRefUri(
  raw: unknown,
  context: string,
  expectedScheme?: "media" | "podcast",
): ResourceRefUri {
  const value = asString(raw, context);
  const parsed = parseResourceRef(value);
  if (
    !parsed ||
    (expectedScheme !== undefined && parsed.scheme !== expectedScheme)
  ) {
    throw new Error(`Invalid ${context}: expected a canonical ResourceRef URI`);
  }
  return value as ResourceRefUri;
}

function slateActionSubject(ref: ResourceRefUri): ResourceActionSubject {
  return { ref: assumeCanonicalResourceRef(ref) };
}

function decodeAnchor(raw: unknown): SlateAnchor {
  const value = asRecord(raw, "SlateAnchorOut");
  exactKeys(value, ["ref", "label"], "SlateAnchorOut");
  return {
    ref: decodeResourceRefUri(value.ref, "SlateAnchorOut.ref"),
    label: asString(value.label, "SlateAnchorOut.label"),
  };
}

function decodeTarget(raw: unknown): SlateTarget {
  const value = asRecord(raw, "SlateTargetOut");
  const kind = asLiteral(
    value.kind,
    ["Media", "Podcast"] as const,
    "SlateTargetOut.kind",
  );
  if (kind === "Media") {
    exactKeys(
      value,
      ["kind", "ref", "mediaKind", "title", "subtitle", "imageUrl", "href"],
      "SlateTargetOut.Media",
    );
    const ref = decodeResourceRefUri(
      value.ref,
      "SlateTargetOut.Media.ref",
      "media",
    );
    const href = assumeAppHref(
      asString(value.href, "SlateTargetOut.Media.href"),
    );
    return {
      kind,
      ref,
      mediaKind: asLiteral(
        value.mediaKind,
        MEDIA_KINDS,
        "SlateTargetOut.Media.mediaKind",
      ),
      title: asString(value.title, "SlateTargetOut.Media.title"),
      subtitle: decodePresence(value.subtitle, (subtitle) =>
        asString(subtitle, "SlateTargetOut.Media.subtitle"),
      ),
      imageUrl: decodePresence(value.imageUrl, (imageUrl) =>
        asString(imageUrl, "SlateTargetOut.Media.imageUrl"),
      ),
      href,
      actionSubject: slateActionSubject(ref),
    };
  }
  exactKeys(
    value,
    ["kind", "ref", "title", "subtitle", "imageUrl", "href"],
    "SlateTargetOut.Podcast",
  );
  const ref = decodeResourceRefUri(
    value.ref,
    "SlateTargetOut.Podcast.ref",
    "podcast",
  );
  const href = assumeAppHref(
    asString(value.href, "SlateTargetOut.Podcast.href"),
  );
  return {
    kind,
    ref,
    title: asString(value.title, "SlateTargetOut.Podcast.title"),
    subtitle: decodePresence(value.subtitle, (subtitle) =>
      asString(subtitle, "SlateTargetOut.Podcast.subtitle"),
    ),
    imageUrl: decodePresence(value.imageUrl, (imageUrl) =>
      asString(imageUrl, "SlateTargetOut.Podcast.imageUrl"),
    ),
    href,
    actionSubject: slateActionSubject(ref),
  };
}

function decodeReason(raw: unknown): SlateReason {
  const value = asRecord(raw, "SlateReasonOut");
  const kind = asLiteral(
    value.kind,
    [
      "Continue",
      "AddedToNexus",
      "Published",
      "NewEpisode",
      "Connected",
      "SharedAuthor",
      "Similar",
    ] as const,
    "SlateReasonOut.kind",
  );
  switch (kind) {
    case "Continue":
      exactKeys(
        value,
        ["kind", "progress", "lastEngagedAt"],
        "SlateReasonOut.Continue",
      );
      return {
        kind,
        progress: decodePresence(value.progress, (progress) => ({
          value: asFraction(progress, "SlateReasonOut.Continue.progress"),
        })),
        lastEngagedAt: expectIsoInstant(
          value.lastEngagedAt,
          "SlateReasonOut.Continue.lastEngagedAt",
        ),
      };
    case "AddedToNexus":
      exactKeys(value, ["kind", "addedAt"], "SlateReasonOut.AddedToNexus");
      return {
        kind,
        addedAt: expectIsoInstant(
          value.addedAt,
          "SlateReasonOut.AddedToNexus.addedAt",
        ),
      };
    case "Published":
      exactKeys(value, ["kind", "publishedOn"], "SlateReasonOut.Published");
      return {
        kind,
        publishedOn: decodePublicationDate(
          value.publishedOn,
          "SlateReasonOut.Published.publishedOn",
        ),
      };
    case "NewEpisode":
      exactKeys(value, ["kind", "publishedAt"], "SlateReasonOut.NewEpisode");
      return {
        kind,
        publishedAt: decodePublicationDate(
          value.publishedAt,
          "SlateReasonOut.NewEpisode.publishedAt",
        ),
      };
    case "Connected":
      exactKeys(
        value,
        ["kind", "anchor", "edgeOrigin"],
        "SlateReasonOut.Connected",
      );
      return {
        kind,
        anchor: decodeAnchor(value.anchor),
        edgeOrigin: asLiteral(
          value.edgeOrigin,
          RESONANCE_EDGE_ORIGINS,
          "SlateReasonOut.Connected.edgeOrigin",
        ),
      };
    case "SharedAuthor":
      exactKeys(
        value,
        ["kind", "anchor", "authorName"],
        "SlateReasonOut.SharedAuthor",
      );
      return {
        kind,
        anchor: decodeAnchor(value.anchor),
        authorName: asString(
          value.authorName,
          "SlateReasonOut.SharedAuthor.authorName",
        ),
      };
    case "Similar":
      exactKeys(value, ["kind", "anchor"], "SlateReasonOut.Similar");
      return { kind, anchor: decodeAnchor(value.anchor) };
  }
}

function decodeSlateItem(raw: unknown): SlateItem {
  const value = asRecord(raw, "SlateItemOut");
  exactKeys(value, ["target", "reason"], "SlateItemOut");
  return {
    target: decodeTarget(value.target),
    reason: decodeReason(value.reason),
  };
}

export function decodeSlateSnapshot(raw: unknown): SlateSnapshot {
  const value = asRecord(raw, "SlateOut");
  exactKeys(value, ["items"], "SlateOut");
  if (!Array.isArray(value.items)) {
    throw new Error("Invalid SlateOut.items: expected an array");
  }
  if (value.items.length > SLATE_LIMIT) {
    throw new Error(`Invalid SlateOut.items: at most ${SLATE_LIMIT} items`);
  }
  const items = value.items.map(decodeSlateItem);
  const refs = new Set<ResourceRefUri>();
  for (const item of items) {
    if (refs.has(item.target.ref)) {
      throw new Error(
        `Invalid SlateOut.items: duplicate ref ${item.target.ref}`,
      );
    }
    refs.add(item.target.ref);
  }
  return { items };
}

export function decodeSlateEnvelope(raw: unknown): SlateSnapshot {
  const value = asRecord(raw, "SlateEnvelope");
  exactKeys(value, ["data"], "SlateEnvelope");
  return decodeSlateSnapshot(value.data);
}

export function slateTargetId(target: SlateTarget): string {
  const parsed = parseResourceRef(target.ref);
  if (!parsed) {
    throw new Error(`Decoded Slate target has invalid ref ${target.ref}`);
  }
  return parsed.id;
}
