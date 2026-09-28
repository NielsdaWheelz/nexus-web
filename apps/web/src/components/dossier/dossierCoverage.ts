import type { Schema } from "@/lib/api/wire";
import { pluralize } from "@/lib/text/pluralize";

function aggregateCoverage(
  singular: string,
  entries: readonly Schema<"MediaManifestEntry">[],
  plural?: string,
): string {
  const included = entries.filter(
    (entry) => entry.disposition === "Included",
  ).length;
  return `${pluralize(entries.length, singular, plural)} · ${included} included · ${entries.length - included} omitted`;
}

export function dossierCoverageLabel(
  manifest: Schema<"DossierRevisionOut">["input_manifest"],
): string {
  switch (manifest.kind) {
    case "media":
      return `${pluralize(manifest.offered_claim_count, "claim")} offered · ${pluralize(manifest.omitted_evidence.length, "evidence item")} omitted`;
    case "conversation":
      return `${pluralize(manifest.message_refs.length, "message")} · ${pluralize(manifest.context_refs.length, "context item")} · complete`;
    case "library":
      return aggregateCoverage("media item", manifest.media);
    case "podcast":
      return aggregateCoverage("episode", manifest.episodes);
    case "contributor":
      return aggregateCoverage("work", manifest.works);
    case "page":
      return `${pluralize(manifest.block_refs.length, "block")} · ${pluralize(manifest.connection_refs.length, "connection")}`;
    case "note":
      return `${manifest.body_fingerprint.kind === "Present" ? "body included" : "body unavailable"} · ${pluralize(manifest.connection_refs.length, "connection")}`;
    case "idea":
      return `${pluralize(manifest.included_seed_refs.length, "learning context")} · ${pluralize(manifest.included_sources.length, "source")} included · ${pluralize(manifest.omitted_sources.length, "source")} omitted`;
    default: {
      const exhaustive: never = manifest;
      throw new Error(`Unhandled Dossier coverage manifest: ${JSON.stringify(exhaustive)}`);
    }
  }
}
