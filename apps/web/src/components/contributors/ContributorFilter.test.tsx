import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ContributorFilter from "./ContributorFilter";

describe("ContributorFilter", () => {
  it("loads selected author labels and filters selected handles from suggestions", async () => {
    const onChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/contributors/ursula-le-guin") {
          return jsonResponse({
            data: {
              handle: "ursula-le-guin",
              display_name: "Ursula K. Le Guin",
            },
          });
        }
        if (path === "/api/contributors?q=le") {
          return jsonResponse({
            data: {
              contributors: [
                {
                  handle: "ursula-le-guin",
                  display_name: "Ursula K. Le Guin",
                },
                {
                  handle: "octavia-butler",
                  display_name: "Octavia E. Butler",
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(<ContributorFilter selectedHandles={["ursula-le-guin"]} onChange={onChange} />);

    expect(await screen.findByRole("link", { name: "Ursula K. Le Guin" })).toHaveAttribute(
      "href",
      "/authors/ursula-le-guin",
    );

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Filter by author" }), "le");

    expect(await screen.findByRole("button", { name: "Octavia E. Butler" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ursula K. Le Guin" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Octavia E. Butler" }));
    expect(onChange).toHaveBeenCalledWith(["ursula-le-guin", "octavia-butler"]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Octavia E. Butler" })).not.toBeInTheDocument();
    });
  });

  it("does not duplicate in-flight selected author hydration", async () => {
    const ursulaResponse = deferred<Response>();
    const octaviaResponse = deferred<Response>();
    const fetchMock = vi.fn((path: string) => {
      if (path === "/api/contributors/ursula-le-guin") {
        return ursulaResponse.promise;
      }
      if (path === "/api/contributors/octavia-butler") {
        return octaviaResponse.promise;
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ContributorFilter
        selectedHandles={["ursula-le-guin", "octavia-butler"]}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/api/contributors/ursula-le-guin",
          "/api/contributors/octavia-butler",
        ])
      );
    });

    await act(async () => {
      ursulaResponse.resolve(
        jsonResponse({
          data: {
            handle: "ursula-le-guin",
            display_name: "Ursula K. Le Guin",
          },
        })
      );
    });

    expect(await screen.findByRole("link", { name: "Ursula K. Le Guin" })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/contributors/octavia-butler")
    ).toHaveLength(1);

    await act(async () => {
      octaviaResponse.resolve(
        jsonResponse({
          data: {
            handle: "octavia-butler",
            display_name: "Octavia E. Butler",
          },
        })
      );
    });

    expect(await screen.findByRole("link", { name: "Octavia E. Butler" })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/contributors/octavia-butler")
    ).toHaveLength(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
