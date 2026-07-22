"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
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

  useEffect(() => {
    if (!publish) return;
    return () => {
      lastPublishedRef.current = null;
      publish(null);
    };
  }, [publish]);
}
