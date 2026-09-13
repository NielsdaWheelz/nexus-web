const ORACLE_PLATE_IMAGE_SRC_RE =
  /^\/api\/oracle\/plates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const oraclePlateImageSrcBrand: unique symbol;

export type OraclePlateImageSrc = `/api/oracle/plates/${string}` & {
  readonly [oraclePlateImageSrcBrand]: true;
};

export function buildOraclePlateImageSrc(id: string): OraclePlateImageSrc {
  return requireOraclePlateImageSrc(`/api/oracle/plates/${id}`);
}

export function isOraclePlateImageSrc(value: string): value is OraclePlateImageSrc {
  return ORACLE_PLATE_IMAGE_SRC_RE.test(value);
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
