import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderProvider, useReaderContext } from "./ReaderContext";
import type { ReaderProfile } from "./types";

const BASE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: "off",
  hyphenation: "auto",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let lastCapability: ReturnType<typeof useReaderContext> | null = null;

function Probe() {
  const capability = useReaderContext();
  lastCapability = capability;
  return (
    <div>
      <output aria-label="theme">{capability.profile.theme}</output>
      <output aria-label="font size">{capability.profile.font_size_px}</output>
      <output aria-label="persistence">{capability.persistence.state}</output>
      <button onClick={() => capability.setTheme("dark")}>set dark</button>
      <button onClick={() => capability.setFontSize(20)}>set font 20</button>
      <button onClick={() => capability.retrySave()}>retry</button>
    </div>
  );
}


function renderProbe() {
  return render(
    <ReaderProvider initialProfile={BASE}>
      <Probe />
    </ReaderProvider>,
  );
}

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler) as FetchStub;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ackResponse(profile: ReaderProfile): Promise<Response> {
  return Promise.resolve(jsonResponse({ data: profile }));
}

describe("ReaderContext", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defects when used outside its provider", () => {
    expect(() => render(<Probe />)).toThrow("useReaderContext requires a ReaderProvider");
  });

  it("seeds the capability from the bootstrap profile without any fetch", () => {
    const fetchMock = stubFetch(() => ackResponse(BASE));
    renderProbe();
    expect(screen.getByLabelText("theme")).toHaveTextContent("light");
    expect(screen.getByLabelText("font size")).toHaveTextContent("16");
    expect(screen.getByLabelText("persistence")).toHaveTextContent("Clean");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates pixels now, PATCHes once with keepalive, and converges to Clean", async () => {
    const acked = { ...BASE, theme: "dark" as const };
    const fetchMock = stubFetch(() => ackResponse(acked));
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "set dark" }));
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark");
    expect(screen.getByLabelText("persistence")).toHaveTextContent("Pending");

    await waitFor(() =>
      expect(screen.getByLabelText("persistence")).toHaveTextContent(/^Clean$/),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(String(path)).toBe("/api/me/reader-profile");
    expect(init?.method).toBe("PATCH");
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ theme: "dark" });
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark");
  });

  it("keeps desired pixels and interactive retry across a retryable failure", async () => {
    const acked = { ...BASE, theme: "dark" as const };
    let failNext = true;
    const fetchMock = stubFetch(() => {
      if (failNext) {
        failNext = false;
        return Promise.resolve(
          jsonResponse({ error: { code: "E_INTERNAL", message: "boom" } }, 500),
        );
      }
      return ackResponse(acked);
    });
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "set dark" }));
    await waitFor(() =>
      expect(screen.getByLabelText("persistence")).toHaveTextContent("SaveFailed"),
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark");

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(screen.getByLabelText("persistence")).toHaveTextContent(/^Clean$/));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ theme: "dark" });
  });

  it("treats 403/E_FORBIDDEN as terminal and restores acknowledged pixels", async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: "E_FORBIDDEN", message: "no" } }, 403)),
    );
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "set dark" }));
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark");
    await waitFor(() =>
      expect(screen.getByLabelText("persistence")).toHaveTextContent("Forbidden"),
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("light");
  });

  it("defects when retrySave is invoked outside SaveFailed", () => {
    stubFetch(() => ackResponse(BASE));
    renderProbe();
    expect(() => lastCapability?.retrySave()).toThrow(
      "retrySave is only available from SaveFailed",
    );
  });

  it("flushes deferred range work on provider teardown instead of dropping it", async () => {
    const fetchMock = stubFetch(() => ackResponse({ ...BASE, font_size_px: 20 }));
    const { unmount } = renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "set font 20" }));
    expect(fetchMock).not.toHaveBeenCalled();

    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ font_size_px: 20 });
  });
});
