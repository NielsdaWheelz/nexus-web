"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { usePanePublication } from "@/components/workspace/usePanePublication";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  arePanePrimaryChromePublicationsEqual,
  type PanePrimaryChromePublication,
  type PanePrimaryChromePublicationUpdate,
} from "@/lib/panes/panePublications";

type PublishPanePrimaryChrome = (
  update: PanePrimaryChromePublicationUpdate,
) => void;

const PanePrimaryChromeContext =
  createContext<PublishPanePrimaryChrome | null>(null);

export function PanePrimaryChromeProvider({
  children,
  publish,
}: {
  readonly children: ReactNode;
  readonly publish: PublishPanePrimaryChrome;
}) {
  return (
    <PanePrimaryChromeContext.Provider value={publish}>
      {children}
    </PanePrimaryChromeContext.Provider>
  );
}

export function usePanePrimaryChrome(
  publication: PanePrimaryChromePublication | null,
): void {
  const publish = useContext(PanePrimaryChromeContext);
  const routeKey = usePaneRuntime()?.routeKey ?? null;
  const publishForRoute = useMemo(
    () =>
      publish && routeKey
        ? (next: PanePrimaryChromePublication | null) =>
            publish({ routeKey, publication: next })
        : null,
    [publish, routeKey],
  );
  usePanePublication({
    publish: publishForRoute,
    publication,
    equals: arePanePrimaryChromePublicationsEqual,
  });
}
