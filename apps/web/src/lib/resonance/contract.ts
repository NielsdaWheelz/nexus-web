/** slate identity and eligibility belong to the domain, not another JSON grammar. */

import type { Schema } from "@/lib/api/wire";
import type { Presence } from "@/lib/api/presence";
import {
  assumeAppHref,
  type AppHref,
  type ConsumptionInfo,
} from "@/lib/lectern/contract";
import { mediaSummaryFromWire, type MediaSummary } from "@/lib/media/mediaSummary";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type ResourceRefUri = string & {
  readonly __resourceRefUri: unique symbol;
};

type TargetIdentity = {
  ref: ResourceRefUri;
  href: AppHref;
  actionSubject: ResourceActionSubject;
};
export type SlateTarget =
  | (Omit<Schema<"MediaSlateTargetOut">, "ref" | "href" | "mediaSummary"> & TargetIdentity & {
      mediaSummary: MediaSummary;
    })
  | (Omit<Schema<"PodcastSlateTargetOut">, "ref" | "href"> & TargetIdentity);
export type SlateItem = Omit<Schema<"SlateItemOut">, "target" | "consumption"> & {
  target: SlateTarget;
  consumption: Presence<ConsumptionInfo>;
};
export type SlateSnapshot = Omit<Schema<"SlateOut">, "items"> & {
  items: SlateItem[];
};

export function slateSnapshotFromWire(slate: Schema<"SlateOut">): SlateSnapshot {
  const refs = new Set<ResourceRefUri>();
  const items = slate.items.map((item): SlateItem => {
    const value = item.target;
    const parsed = parseResourceRef(value.ref);
    if (!parsed || parsed.scheme !== (value.kind === "Media" ? "media" : "podcast")) {
      throw new Error(`Invalid SlateTargetOut.${value.kind}.ref: expected a canonical ResourceRef URI`);
    }
    // justify-type-assertion: the canonical ref parser and scheme check establish the brand.
    const ref = value.ref as ResourceRefUri;
    if (refs.has(ref)) {
      throw new Error(`Invalid SlateOut.items: duplicate ref ${ref}`);
    }
    refs.add(ref);
    const common = {
      ref,
      href: assumeAppHref(value.href),
      actionSubject: { ref: assumeCanonicalResourceRef(ref) },
      imageUrl: value.imageUrl,
    };
    if (value.kind === "Media") {
      const mediaSummary = mediaSummaryFromWire(value.mediaSummary);
      if (ref !== `media:${mediaSummary.mediaId}`) {
        throw new TypeError("Slate media target identity mismatch");
      }
      if (item.consumption.kind !== "Present") {
        throw new Error("Invalid SlateItemOut.Media: consumption must be present");
      }
      return {
        target: { ...common, kind: "Media", mediaSummary },
        consumption: item.consumption,
      };
    }
    if (item.consumption.kind !== "Absent") {
      throw new Error("Invalid SlateItemOut.Podcast: consumption must be absent");
    }
    return {
      target: {
        ...common,
        kind: "Podcast",
        title: value.title,
        subtitle: value.subtitle,
      },
      consumption: item.consumption,
    };
  });
  return { items };
}

export function slateTargetId(target: SlateTarget): string {
  const parsed = parseResourceRef(target.ref);
  if (!parsed) {
    throw new Error(`Decoded Slate target has invalid ref ${target.ref}`);
  }
  return parsed.id;
}
