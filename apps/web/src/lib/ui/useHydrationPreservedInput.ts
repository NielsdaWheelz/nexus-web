"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

/** A controlled input that keeps what was typed before hydration. */
export function useHydrationPreservedInput(initialValue = "") {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const update = useCallback(
    (event: ChangeEvent<HTMLInputElement> | FormEvent<HTMLInputElement>) =>
      setValue(event.currentTarget.value),
    [],
  );
  // At hydration, adopt whatever the server-rendered input already holds.
  useEffect(() => {
    const typed = inputRef.current?.value;
    if (typed !== undefined) setValue(typed);
  }, []);
  return {
    value,
    setValue,
    inputProps: { ref: inputRef, value, onChange: update, onInput: update },
  } as const;
}
