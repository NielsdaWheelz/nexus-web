# Control Flow

## Scope

This document covers exhaustive branching and race-safety rules.

## Exhaustiveness

- When branching on a value with a known finite set of possibilities, prefer exhaustive matching.
- Do not use catch-all or default branches that silently accept new variants.
- TypeScript: use `never` checks or `satisfies` to enforce exhaustiveness at compile time.
- Python: use `assert_never` (typing) or explicit `if`/`elif` chains with a final `raise` for unreachable branches.
- Apply the same rule to error channels.
- Handle errors by name with explicit branches. Do not use bare `except Exception` or `catch (e)` to swallow errors.
- Any branch that discards an error must first narrow it to a specific type and include `justify-ignore-error`.

## Races

- Do not race an operation that performs a destructive or non-idempotent side effect unless losing the result is acceptable.
- When concurrent operations need to coordinate around destructive side effects, route signals through a single serialization point.
