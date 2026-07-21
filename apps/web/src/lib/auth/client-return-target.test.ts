import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLoginUrlForCurrentLocation,
  redirectToLoginForCurrentLocation,
} from "./client-return-target";

function stubLocation(pathname: string, search = "") {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: {
      assign,
      origin: "http://localhost:3000",
      pathname,
      search,
    },
  });
  return assign;
}

describe("client auth return target", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds login URLs from the current non-default location", () => {
    stubLocation("/browse", "?q=audio");

    expect(buildLoginUrlForCurrentLocation()).toBe(
      "http://localhost:3000/login?next=%2Fbrowse%3Fq%3Daudio"
    );
  });

  it("omits default next from current-location login URLs", () => {
    stubLocation("/lectern");

    expect(buildLoginUrlForCurrentLocation()).toBe(
      "http://localhost:3000/login"
    );
  });

  it("does not redirect while already on login", () => {
    const assign = stubLocation("/login", "?next=%2Fbrowse");

    expect(redirectToLoginForCurrentLocation()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects to the current-location login URL", () => {
    const assign = stubLocation("/media/1", "?view=reader");

    expect(redirectToLoginForCurrentLocation()).toBe(true);
    expect(assign).toHaveBeenCalledWith(
      "http://localhost:3000/login?next=%2Fmedia%2F1%3Fview%3Dreader"
    );
  });
});
