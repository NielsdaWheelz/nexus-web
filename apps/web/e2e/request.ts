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
    private readonly browserContext?: BrowserContext,
  ) {
    this.origin = canonicalOrigin(origin);
  }

  async get(target: string, options?: GetOptions): Promise<APIResponse> {
    const url = exactTarget(this.origin, target);
    return this.context.get(
      url,
      noRedirects({
        ...options,
        headers: await this.headers(url, options?.headers),
      }),
    );
  }

  async post(target: string, options?: PostOptions): Promise<APIResponse> {
    const url = exactTarget(this.origin, target);
    return this.context.post(
      url,
      noRedirects({
        ...options,
        headers: await this.headers(url, options?.headers),
      }),
    );
  }

  async put(target: string, options?: PutOptions): Promise<APIResponse> {
    const url = exactTarget(this.origin, target);
    return this.context.put(
      url,
      noRedirects({
        ...options,
        headers: await this.headers(url, options?.headers),
      }),
    );
  }

  async delete(target: string, options?: DeleteOptions): Promise<APIResponse> {
    const url = exactTarget(this.origin, target);
    return this.context.delete(
      url,
      noRedirects({
        ...options,
        headers: await this.headers(url, options?.headers),
      }),
    );
  }

  async dispose(): Promise<void> {
    if (this.ownsContext) await this.context.dispose();
  }

  private async headers(
    url: string,
    supplied: Record<string, string> | undefined,
  ): Promise<Record<string, string>> {
    const headers = { ...supplied };
    if (!this.browserContext) return headers;
    if (Object.keys(headers).some((name) => name.toLowerCase() === "cookie")) {
      throw new Error("Browser-owned requests cannot override the context cookie jar.");
    }
    const cookies = await this.browserContext.cookies(url);
    if (cookies.length > 0) {
      headers.Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    }
    return headers;
  }
}

export function pageRequest(page: Page, origin: string): ExactOriginRequest {
  return new ExactOriginRequest(page.request, origin, false, page.context());
}

export function contextRequest(
  context: BrowserContext,
  origin: string,
): ExactOriginRequest {
  return new ExactOriginRequest(context.request, origin, false, context);
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
