import type { APIRequestContext } from "@playwright/test";

export async function deleteE2eResource(
  request: APIRequestContext,
  path: string,
  label: string,
) {
  const response = await request.delete(path, { timeout: 5_000 });
  if (response.ok() || response.status() === 404) {
    return;
  }
  throw new Error(
    `${label} cleanup failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
  );
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
      `${label} product assertion and cleanup failed`,
    );
  }
  throw new AggregateError(cleanupErrors, `${label} cleanup failed`);
}
