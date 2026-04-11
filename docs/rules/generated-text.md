# Generated Text

## Scope

This document covers escaping and quoting at generated-text boundaries.

## Rules

- Escape or quote every interpolated value inline at the generated-text use site.
- Do not rely on prior validation or informal knowledge that a value cannot contain special characters.
- For shell token boundaries, prefer `shellQuoteOrDie` or `shellQuote`.
- Keep fixed values in the host language and escape them inline at each shell use site.
- Use shell variables for genuinely dynamic runtime values.
- Keep shell variables quoted at each use site.
