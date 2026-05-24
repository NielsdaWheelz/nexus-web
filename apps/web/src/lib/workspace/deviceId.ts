import { createRandomId } from "@/lib/createRandomId";

const STORAGE_KEY = "nexus.installationId.v1";

export function getInstallationId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return stored;
    }
  } catch { /* ignore */ }

  const id = createRandomId();

  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* quota or private mode */ }

  return id;
}
