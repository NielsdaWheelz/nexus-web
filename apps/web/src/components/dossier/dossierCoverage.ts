import type {
  DossierInputManifest,
  DossierMediaManifestEntry,
} from "@/lib/dossiers/dossierControllerTypes";
import { pluralize } from "@/lib/text/pluralize";

function aggregateCoverage(
  singular: string,
  entries: readonly DossierMediaManifestEntry[],
  plural?: string,
): string {
  const included = entries.filter(
    (entry) => entry.disposition === "Included",
  ).length;
  return `${pluralize(entries.length, singular, plural)} · ${included} included · ${entries.length - included} omitted`;
}

export function dossierCoverageLabel(manifest: DossierInputManifest): string {
  switch (manifest.kind) {
    case "media":
      return `${pluralize(manifest.offeredClaimCount, "claim")} offered · ${pluralize(manifest.omittedEvidenceRefs.length, "evidence item")} omitted`;
    case "conversation":
      return `${pluralize(manifest.messageRefs.length, "message")} · ${pluralize(manifest.contextRefs.length, "context item")} · ${
        manifest.completeness.kind === "Complete" ? "complete" : "incomplete"
      }`;
    case "library":
      return aggregateCoverage("media item", manifest.media);
    case "podcast":
      return aggregateCoverage("episode", manifest.episodes);
    case "contributor":
      return aggregateCoverage("work", manifest.works);
    case "page":
      return `${pluralize(manifest.blockRefs.length, "block")} · ${pluralize(manifest.connectionRefs.length, "connection")}`;
    case "note":
      return `${manifest.bodyFingerprint.kind === "Present" ? "body included" : "body unavailable"} · ${pluralize(manifest.connectionRefs.length, "connection")}`;
    default: {
      const exhaustive: never = manifest;
      throw new Error(`Unhandled Dossier coverage manifest: ${JSON.stringify(exhaustive)}`);
    }
  }
}
