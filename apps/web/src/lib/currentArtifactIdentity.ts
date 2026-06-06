import { isRecord } from "@/lib/validation";

const LEGACY_ARTIFACT_IDENTITY_KEYS = new Set([
  "basePageRevision",
  "baseRevision",
  "base_page_revision",
  "base_revision",
  "contentHash",
  "contentSha256",
  "content_hash",
  "content_sha256",
  "fileSha256",
  "file_sha256",
  "fingerprint",
  "geometryFingerprint",
  "geometryVersion",
  "geometry_fingerprint",
  "geometry_version",
  "hash",
  "manifestSha256",
  "manifest_sha256",
  "revision",
  "sha256",
  "sourceFingerprint",
  "sourceVersion",
  "source_fingerprint",
  "source_sha256",
  "source_version",
  "transcriptVersionId",
  "transcript_version_id",
  "version",
]);

export function hasLegacyArtifactIdentityKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasLegacyArtifactIdentityKey);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      LEGACY_ARTIFACT_IDENTITY_KEYS.has(key) ||
      hasLegacyArtifactIdentityKey(child),
  );
}

export function hasTopLevelLegacyArtifactIdentityKey(
  value: Record<string, unknown>,
): boolean {
  return Object.keys(value).some((key) => LEGACY_ARTIFACT_IDENTITY_KEYS.has(key));
}

export function assertNoTopLevelLegacyArtifactIdentityKey(
  value: Record<string, unknown>,
  label: string,
): void {
  if (hasTopLevelLegacyArtifactIdentityKey(value)) {
    throw new Error(`${label} includes legacy artifact identity`);
  }
}
