/**
 * Exhaustiveness check: the call compiles only while `value` is provably
 * impossible, so an added variant becomes a type error at every consumer, and a
 * value that reaches here anyway fails loudly instead of falling through.
 */
export function assertNever(value: never, context?: string): never {
  const detail = JSON.stringify(value);
  throw new Error(
    context === undefined
      ? `Unreachable variant: ${detail}`
      : `${context}: ${detail}`,
  );
}
