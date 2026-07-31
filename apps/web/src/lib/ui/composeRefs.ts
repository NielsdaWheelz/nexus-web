import type { Ref, RefCallback } from "react";

type RefRelease = () => void;

function assignRef<T>(ref: Ref<T>, value: T): RefRelease {
  if (typeof ref === "function") {
    const cleanup = ref(value);
    return typeof cleanup === "function" ? cleanup : () => ref(null);
  }
  if (ref === null) return () => {};
  ref.current = value;
  return () => {
    ref.current = null;
  };
}

export function composeRefs<T>(...refs: readonly Ref<T>[]): RefCallback<T> {
  return (value) => {
    if (value === null) return;
    const releases = refs.map((ref) => assignRef(ref, value));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        releases[index]();
      }
    };
  };
}
