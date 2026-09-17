"use client";

import { useEffect } from "react";

export interface WindowEventChannel<T> {
  readonly eventName: string;
  dispatch(target: T): boolean;
  useSubscribe(handler: (target: T) => boolean | void): void;
}

export function createWindowEventChannel<T>({
  eventName,
  cancelable,
}: {
  readonly eventName: string;
  readonly cancelable: boolean;
}): WindowEventChannel<T> {
  function dispatch(target: T): boolean {
    const event = new CustomEvent<T>(eventName, {
      cancelable,
      detail: target,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function useSubscribe(
    handler: (target: T) => boolean | void,
  ): void {
    useEffect(() => {
      function listener(event: Event) {
        if (!(event instanceof CustomEvent)) return;
        if (handler((event as CustomEvent<T>).detail) === true) {
          event.preventDefault();
        }
      }
      window.addEventListener(eventName, listener);
      return () => window.removeEventListener(eventName, listener);
    }, [handler]);
  }

  return { eventName, dispatch, useSubscribe };
}
