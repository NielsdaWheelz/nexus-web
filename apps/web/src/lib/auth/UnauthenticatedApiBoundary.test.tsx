import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import UnauthenticatedApiBoundary, {
  __resetUnauthenticatedApiRedirectForTests,
  handleUnauthenticatedApiError,
  useUnauthenticatedApiHandler,
} from "./UnauthenticatedApiBoundary";

const redirectToLoginForCurrentLocation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client-return-target", () => ({
  redirectToLoginForCurrentLocation,
}));

function Probe({ error }: { error: unknown }) {
  const handle = useUnauthenticatedApiHandler();
  return (
    <button type="button" onClick={() => handle(error)}>
      trigger
    </button>
  );
}

describe("UnauthenticatedApiBoundary", () => {
  afterEach(() => {
    redirectToLoginForCurrentLocation.mockReset();
    __resetUnauthenticatedApiRedirectForTests();
  });

  it("redirects once for unauthenticated API errors", () => {
    redirectToLoginForCurrentLocation.mockReturnValue(true);
    render(
      <UnauthenticatedApiBoundary>
        <Probe
          error={
            new ApiError(
              401,
              "E_UNAUTHENTICATED",
              "Authentication required"
            )
          }
        />
      </UnauthenticatedApiBoundary>
    );

    fireEvent.click(screen.getByRole("button", { name: "trigger" }));
    fireEvent.click(screen.getByRole("button", { name: "trigger" }));

    expect(redirectToLoginForCurrentLocation).toHaveBeenCalledTimes(1);
  });

  it("ignores non-auth API errors", () => {
    render(
      <UnauthenticatedApiBoundary>
        <Probe error={new ApiError(403, "E_FORBIDDEN", "Forbidden")} />
      </UnauthenticatedApiBoundary>
    );

    fireEvent.click(screen.getByRole("button", { name: "trigger" }));

    expect(redirectToLoginForCurrentLocation).not.toHaveBeenCalled();
  });

  it("handles caught unauthenticated API errors once", () => {
    redirectToLoginForCurrentLocation.mockReturnValue(true);
    const error = new ApiError(
      401,
      "E_UNAUTHENTICATED",
      "Authentication required",
    );

    expect(handleUnauthenticatedApiError(error)).toBe(true);
    expect(handleUnauthenticatedApiError(error)).toBe(true);

    expect(redirectToLoginForCurrentLocation).toHaveBeenCalledTimes(1);
  });
});
