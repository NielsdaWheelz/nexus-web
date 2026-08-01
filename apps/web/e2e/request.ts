import {
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type Response as BrowserResponse,
} from "playwright/test";

type DeleteOptions = Parameters<APIRequestContext["delete"]>[1];
type GetOptions = Parameters<APIRequestContext["get"]>[1];
type PostOptions = Parameters<APIRequestContext["post"]>[1];
type PutOptions = Parameters<APIRequestContext["put"]>[1];
type NewContextOptions = NonNullable<
  Parameters<typeof playwrightRequest.newContext>[0]
>;

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error(`Expected an exact HTTP origin, received ${JSON.stringify(value)}.`);
  }
  return url.origin;
}

function exactTarget(
  origin: string,
  target: string,
  options: { allowHash?: boolean } = {},
): string {
  const url = target.startsWith("/")
    ? new URL(target, `${origin}/`)
    : new URL(target);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (!options.allowHash && url.hash)
  ) {
    throw new Error(
      `Request target ${JSON.stringify(target)} is outside exact origin ${origin}.`,
    );
  }
  return url.toString();
}

function noRedirects<T extends { maxRedirects?: number }>(options: T | undefined): T {
  if (options?.maxRedirects !== undefined && options.maxRedirects !== 0) {
    throw new Error("Harness-owned API requests cannot follow redirects.");
  }
  return { ...options, maxRedirects: 0 } as T;
}

export class ExactOriginRequest {
  readonly origin: string;

  constructor(
    private readonly context: APIRequestContext,
    origin: string,
    private readonly ownsContext = false,
  ) {
    this.origin = canonicalOrigin(origin);
  }

  get(target: string, options?: GetOptions): Promise<APIResponse> {
    return this.context.get(exactTarget(this.origin, target), noRedirects(options));
  }

  post(target: string, options?: PostOptions): Promise<APIResponse> {
    return this.context.post(exactTarget(this.origin, target), noRedirects(options));
  }

  put(target: string, options?: PutOptions): Promise<APIResponse> {
    return this.context.put(exactTarget(this.origin, target), noRedirects(options));
  }

  delete(target: string, options?: DeleteOptions): Promise<APIResponse> {
    return this.context.delete(exactTarget(this.origin, target), noRedirects(options));
  }

  async dispose(): Promise<void> {
    if (this.ownsContext) await this.context.dispose();
  }
}

export function pageRequest(page: Page, origin: string): ExactOriginRequest {
  return new ExactOriginRequest(page.request, origin);
}

export function contextRequest(
  context: BrowserContext,
  origin: string,
): ExactOriginRequest {
  return new ExactOriginRequest(context.request, origin);
}

export async function isolatedRequest(
  origin: string,
  options: Omit<NewContextOptions, "baseURL" | "maxRedirects"> = {},
): Promise<ExactOriginRequest> {
  const exactOrigin = canonicalOrigin(origin);
  const context = await playwrightRequest.newContext({
    ...options,
    baseURL: exactOrigin,
    maxRedirects: 0,
  });
  return new ExactOriginRequest(context, exactOrigin, true);
}

export function requireExactOrigin(target: string, origin: string): URL {
  return new URL(
    exactTarget(canonicalOrigin(origin), target, { allowHash: true }),
  );
}

export function matchesResponse(
  response: BrowserResponse,
  origin: string,
  method: string,
  pathname: string | RegExp,
): boolean {
  const url = new URL(response.url());
  const pathMatches =
    typeof pathname === "string"
      ? url.pathname === pathname
      : pathname.test(url.pathname);
  return (
    url.origin === canonicalOrigin(origin) &&
    response.request().method() === method &&
    pathMatches
  );
}
