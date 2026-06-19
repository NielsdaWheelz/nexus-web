"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

export function useHydrationPreservedInput(initialValue = "") {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef(initialValue);
  const [value, setValueState] = useState(initialValue);

  const setValue = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    setValueState(nextValue);
  }, []);

  const updateFromEvent = useCallback(
    (event: ChangeEvent<HTMLInputElement> | FormEvent<HTMLInputElement>) => {
      setValue(event.currentTarget.value);
    },
    [setValue],
  );

  useEffect(() => {
    const domValue = inputRef.current?.value;
    if (domValue !== undefined && domValue !== valueRef.current) {
      setValue(domValue);
    }
  }, [setValue]);

  return {
    value,
    setValue,
    inputProps: {
      ref: inputRef,
      value,
      onChange: updateFromEvent,
      onInput: updateFromEvent,
    },
  } as const;
}
