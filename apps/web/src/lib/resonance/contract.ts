/** Strict same-system transport contract for Resonance reading slates. */

import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  assumeAppHref,
  decodeConsumption,
  type AppHref,
  type ConsumptionInfo,
} from "@/lib/lectern/contract";
import { decodeMediaSummary, type MediaSummary } from "@/lib/media/mediaSummary";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { expectExactRecord, expectRecord } from "@/lib/validation";

const SLATE_LIMIT = 10;

export type ResourceRefUri = string & {
  readonly __resourceRefUri: unique symbol;
};

interface SlateTargetBase {
  ref: ResourceRefUri;
  href: AppHref;
  actionSubject: ResourceActionSubject;
}

export type SlateTarget =
  | (SlateTargetBase & { kind: "Media"; mediaSummary: MediaSummary; imageUrl: Presence<string> })
  | (SlateTargetBase & { kind: "Podcast"; title: string; subtitle: Presence<string>; imageUrl: Presence<string> });

export interface SlateItem {
  target: SlateTarget;
  consumption: Presence<ConsumptionInfo>;
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

function decodeResourceRefUri(
  raw: unknown,
  context: string,
  expectedScheme: "media" | "podcast",
): ResourceRefUri {
  const value = asString(raw, context);
  const parsed = parseResourceRef(value);
  if (!parsed || parsed.scheme !== expectedScheme) {
    throw new Error(`Invalid ${context}: expected a canonical ResourceRef URI`);
  }
  return value as ResourceRefUri;
}

function slateActionSubject(ref: ResourceRefUri): ResourceActionSubject {
  return { ref: assumeCanonicalResourceRef(ref) };
}

function decodeTarget(raw: unknown): SlateTarget {
  const value = expectRecord(raw, "SlateTargetOut");
  const kind = asLiteral(
    value.kind,
    ["Media", "Podcast"] as const,
    "SlateTargetOut.kind",
  );
  if (kind === "Media") {
    expectExactRecord(
      value,
      ["kind", "ref", "mediaSummary", "imageUrl", "href"],
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
    const mediaSummary = decodeMediaSummary(value.mediaSummary);
    if (ref !== `media:${mediaSummary.mediaId}`) {
      throw new TypeError("Slate media target identity mismatch");
    }
    return {
      kind,
      ref,
      mediaSummary,
      imageUrl: decodePresence(value.imageUrl, (imageUrl) =>
        asString(imageUrl, "SlateTargetOut.Media.imageUrl"),
      ),
      href,
      actionSubject: slateActionSubject(ref),
    };
  }
  expectExactRecord(
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

function decodeSlateItem(raw: unknown): SlateItem {
  const value = expectExactRecord(
    raw,
    ["target", "consumption"],
    "SlateItemOut",
  );
  const target = decodeTarget(value.target);
  const consumption = decodePresence(value.consumption, decodeConsumption);
  if (target.kind === "Podcast") {
    if (consumption.kind !== "Absent") throw new Error("Invalid SlateItemOut.Podcast: consumption must be absent");
  } else {
    if (consumption.kind !== "Present") {
      throw new Error("Invalid SlateItemOut.Media: consumption must be present");
    }
  }
  return { target, consumption };
}

export function decodeSlateSnapshot(raw: unknown): SlateSnapshot {
  const value = expectExactRecord(raw, ["items"], "SlateOut");
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
  const value = expectExactRecord(raw, ["data"], "SlateEnvelope");
  return decodeSlateSnapshot(value.data);
}

export function decodeQuickReadsEnvelope(raw: unknown): SlateSnapshot {
  const snapshot = decodeSlateEnvelope(raw);
  if (snapshot.items.length > 5) {
    throw new Error("Invalid quick reads: at most 5 items");
  }
  for (const item of snapshot.items) {
    if (
      item.target.kind !== "Media" ||
      (item.target.mediaSummary.mediaKind !== "web_article" &&
        item.target.mediaSummary.mediaKind !== "epub" &&
        item.target.mediaSummary.mediaKind !== "pdf") ||
      item.consumption.kind !== "Present" ||
      item.target.mediaSummary.duration.kind !== "Present" ||
      item.target.mediaSummary.duration.value.estimate.remainingMinutes.kind !== "Present" ||
      item.target.mediaSummary.duration.value.estimate.remainingMinutes.value.value <= 0
    ) {
      throw new Error(
        "Invalid quick read: requires a document with consumption and a positive remaining estimate",
      );
    }
  }
  return snapshot;
}

export function slateTargetId(target: SlateTarget): string {
  const parsed = parseResourceRef(target.ref);
  if (!parsed) {
    throw new Error(`Decoded Slate target has invalid ref ${target.ref}`);
  }
  return parsed.id;
}
