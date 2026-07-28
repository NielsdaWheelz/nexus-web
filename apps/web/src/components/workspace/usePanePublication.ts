"use client";

import { useLayoutEffect, useRef } from "react";

export function usePanePublication<Publication>(input: {
  readonly publish: ((publication: Publication | null) => void) | null;
  readonly publication: Publication | null;
  readonly equals: (
    left: Publication | null,
    right: Publication | null,
  ) => boolean;
}): void {
  const { publish, publication, equals } = input;
  const lastPublishedRef = useRef<{
    readonly publish: (publication: Publication | null) => void;
    readonly publication: Publication | null;
  } | null>(null);

  // Publications and the controls derived from them are one UI contract. Commit
  // the owner record before paint so a control can never become actionable one
  // frame before its host-side publication is ready to accept the command.
  useLayoutEffect(() => {
    if (!publish) return;
    const previous = lastPublishedRef.current;
    if (
      previous?.publish === publish &&
      equals(previous.publication, publication)
    ) {
      return;
    }
    publish(publication);
    lastPublishedRef.current = { publish, publication };
  }, [equals, publication, publish]);

  useLayoutEffect(() => {
    if (!publish) return;
    return () => {
      lastPublishedRef.current = null;
      publish(null);
    };
  }, [publish]);
}
