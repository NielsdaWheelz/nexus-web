import { isCanonicalUuid } from "@/lib/validation";

const ORACLE_PLATE_IMAGE_PREFIX = "/api/oracle/plates/";

declare const oraclePlateImageSrcBrand: unique symbol;

export type OraclePlateImageSrc = `/api/oracle/plates/${string}` & {
  readonly [oraclePlateImageSrcBrand]: true;
};

export function buildOraclePlateImageSrc(id: string): OraclePlateImageSrc {
  return requireOraclePlateImageSrc(`/api/oracle/plates/${id}`);
}

export function isOraclePlateImageSrc(value: string): value is OraclePlateImageSrc {
  return (
    value.startsWith(ORACLE_PLATE_IMAGE_PREFIX) &&
    isCanonicalUuid(value.slice(ORACLE_PLATE_IMAGE_PREFIX.length))
  );
}

export function parseOraclePlateImageSrc(value: string): OraclePlateImageSrc | null {
  return isOraclePlateImageSrc(value) ? value : null;
}

export function requireOraclePlateImageSrc(value: string): OraclePlateImageSrc {
  const parsed = parseOraclePlateImageSrc(value);
  if (parsed === null) {
    throw new Error("Invalid Oracle plate image URL");
  }
  return parsed;
}
