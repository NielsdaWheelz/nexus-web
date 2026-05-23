export interface InternalApiConfig {
  fastApiBaseUrl: string;
  internalSecret: string;
}

export function getInternalApiConfig(): InternalApiConfig {
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET || "";
  return { fastApiBaseUrl, internalSecret };
}

// Returns true when the internal-API config is usable for a BFF call: a base
// URL is set, and outside production we tolerate a missing internal secret.
export function isInternalApiConfigured(config: InternalApiConfig): boolean {
  return Boolean(
    config.fastApiBaseUrl &&
      (process.env.NODE_ENV !== "production" || config.internalSecret),
  );
}
