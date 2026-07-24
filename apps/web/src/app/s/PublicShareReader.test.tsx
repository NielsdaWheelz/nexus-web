import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PublicFragmentPage,
  PublicShareBootstrap,
} from "@/lib/sharing/publicContract";
import PublicShareReader from "./PublicShareReader";

const publicClient = vi.hoisted(() => ({
  readPublicShareBootstrap: vi.fn(),
  readAllPublicFragments: vi.fn(),
  readAllPublicNavigation: vi.fn(),
  readPublicAsset: vi.fn(),
  readPublicSection: vi.fn(),
  publicPdfSource: vi.fn(),
}));

vi.mock("@/lib/sharing/publicClient", () => publicClient);

const TOKEN_A = `nxshr1_${"A".repeat(43)}`;
const TOKEN_B = `nxshr1_${"B".repeat(43)}`;
const TOKEN_C = `nxshr1_${"C".repeat(43)}`;

function articleBootstrap(title: string): PublicShareBootstrap {
  return {
    version: "V1",
    subject: { kind: "Media" },
    media: {
      title,
      mediaKind: "Article",
      sourceUrl: { kind: "Absent" },
      bylines: [],
    },
    reader: { kind: "Article" },
  };
}

const EMPTY_ARTICLE: PublicFragmentPage = {
  kind: "ArticleFragments",
  items: [],
  nextCursor: { kind: "Absent" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("PublicShareReader hash resolution", () => {
  beforeEach(() => {
    document.title = "Nexus";
    publicClient.readAllPublicFragments.mockResolvedValue(EMPTY_ARTICLE);
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/s");
    document.title = "Nexus";
    vi.restoreAllMocks();
  });

  it("keeps an aborted older token from restoring private state after a masked failure", async () => {
    const delayedB = deferred<PublicShareBootstrap>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    publicClient.readPublicShareBootstrap.mockImplementation(
      (token: string) => {
        if (token === TOKEN_A) {
          return Promise.resolve(articleBootstrap("Private title A"));
        }
        if (token === TOKEN_B) {
          return delayedB.promise;
        }
        return Promise.reject(new Error("Share unavailable"));
      }
    );
    window.history.replaceState(null, "", `/s#share=${TOKEN_A}`);
    render(<PublicShareReader />);

    expect(await screen.findByRole("heading", { name: "Private title A" })).toBeVisible();
    expect(document.title).toBe("Private title A · Nexus");

    act(() => {
      window.history.replaceState(null, "", `/s#share=${TOKEN_B}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(document.title).toBe("Nexus");

    act(() => {
      window.history.replaceState(null, "", `/s#share=${TOKEN_C}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("heading", { name: "Share unavailable" })).toBeVisible();
    expect(document.title).toBe("Nexus");

    await act(async () => {
      delayedB.resolve(articleBootstrap("Private title B"));
      await delayedB.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Share unavailable" })).toBeVisible();
    });
    expect(screen.queryByText("Private title B")).not.toBeInTheDocument();
    expect(document.title).toBe("Nexus");
    expect(
      consoleError.mock.calls.filter(
        ([event]) => event === "public_share_resolution_failed"
      )
    ).toHaveLength(1);
  });
});
