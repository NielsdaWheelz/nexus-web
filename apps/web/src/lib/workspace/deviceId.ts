const STORAGE_KEY = "nexus.installationId.v1";

export function getInstallationId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return stored;
    }
  } catch { /* ignore */ }

  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* quota or private mode */ }

  return id;
}
