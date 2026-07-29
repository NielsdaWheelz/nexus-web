import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useDebouncedFetch } from "./useDebouncedFetch";

function Probe({
  requestKey,
  identity,
  fetcher,
}: {
  requestKey: string;
  identity: string;
  fetcher: () => Promise<string>;
}) {
  const state = useDebouncedFetch(requestKey, fetcher, {
    debounceMs: 0,
    identity,
  });
  return <output>{JSON.stringify(state)}</output>;
}

it("keys committed state by logical identity and preserves it across a failed retry", async () => {
  const { rerender } = render(
    <Probe
      requestKey="alpha:0"
      identity="alpha"
      fetcher={() => Promise.resolve("Alpha")}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText(/"data":"Alpha"/)).toBeVisible(),
  );

  rerender(
    <Probe
      requestKey="alpha:1"
      identity="alpha"
      fetcher={() => Promise.reject(new Error("offline"))}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText(/"errorIdentity":"alpha"/)).toBeVisible(),
  );
  expect(screen.getByText(/"data":"Alpha"/)).toBeVisible();
  expect(screen.getByText(/"dataIdentity":"alpha"/)).toBeVisible();

  rerender(
    <Probe
      requestKey="beta:0"
      identity="beta"
      fetcher={() => Promise.resolve("Beta")}
    />,
  );
  expect(screen.getByText(/"dataIdentity":"alpha"/)).toBeVisible();
  await waitFor(() =>
    expect(screen.getByText(/"data":"Beta"/)).toBeVisible(),
  );
  expect(screen.getByText(/"dataIdentity":"beta"/)).toBeVisible();
});
