import type { APIRequestContext } from "@playwright/test";

export async function deleteE2eResource(
  request: APIRequestContext,
  path: string,
  label: string,
) {
  const response = path.startsWith("/api/notes/blocks/")
    ? await deleteNoteBlockResource(request, path)
    : await request.delete(path, { timeout: 5_000 });
  if (response.ok() || response.status() === 404) {
    return;
  }
  throw new Error(
    `${label} cleanup failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
  );
}

async function deleteNoteBlockResource(request: APIRequestContext, path: string) {
  const current = await request.get(path, { timeout: 5_000 });
  if (current.status() === 404) {
    return current;
  }
  if (!current.ok()) {
    return current;
  }
  const payload = (await current.json()) as { data?: { revision?: number } };
  const revision = payload.data?.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    throw new Error(`Note block cleanup missing revision: ${path}`);
  }
  return request.delete(path, {
    timeout: 5_000,
    data: { base_revision: revision },
  });
}

export function throwE2eCleanupFailures(
  label: string,
  productError: unknown,
  cleanupErrors: unknown[],
) {
  if (cleanupErrors.length === 0) {
    return;
  }
  if (productError) {
    throw new AggregateError(
      [productError, ...cleanupErrors],
      [
        `${label} product assertion and cleanup failed`,
        `product: ${describeError(productError)}`,
        ...cleanupErrors.map((error, index) => `cleanup ${index + 1}: ${describeError(error)}`),
      ].join("\n"),
    );
  }
  throw new AggregateError(
    cleanupErrors,
    [
      `${label} cleanup failed`,
      ...cleanupErrors.map((error, index) => `cleanup ${index + 1}: ${describeError(error)}`),
    ].join("\n"),
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
