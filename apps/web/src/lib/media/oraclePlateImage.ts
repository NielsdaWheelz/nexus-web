import { isCanonicalUuid } from "@/lib/validation";

const ORACLE_PLATE_IMAGE_PREFIX = "/api/oracle/plates/";

declare const oraclePlateImageSrcBrand: unique symbol;

export type OraclePlateImageSrc = `${typeof ORACLE_PLATE_IMAGE_PREFIX}${string}` & {
  readonly [oraclePlateImageSrcBrand]: true;
};

export function requireOraclePlateImageSrc(value: string): OraclePlateImageSrc {
  if (
    !value.startsWith(ORACLE_PLATE_IMAGE_PREFIX) ||
    !isCanonicalUuid(value.slice(ORACLE_PLATE_IMAGE_PREFIX.length))
  ) {
    throw new Error("Invalid Oracle plate image URL");
  }
  return value as OraclePlateImageSrc;
}
