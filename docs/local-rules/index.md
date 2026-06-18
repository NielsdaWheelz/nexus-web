# Local Rules

## Role

Repository-specific engineering rules for nexus-web. These complement the
shared, language-agnostic standards mirrored from the
[engineering-docs](https://github.com/NielsdaWheelz/engineering-docs) repo in
[../rules/](../rules/), which is kept in sync via `git subtree`.

## Documents

- [tech-stack.md](tech-stack.md): runtime and tooling stack.
- [codebase.md](codebase.md): repo structure, module ownership, import specifics, and the `.env.example` contract.
- [entrypoints.md](entrypoints.md): where this repo's entrypoints concretely live.
- [testing_standards.md](testing_standards.md): Nexus testing standards and test tiers.

## Boundary

Shared, reusable engineering rules live in [../rules/](../rules/) and are
updated by pulling the engineering-docs subtree — do not hand-edit them here;
contribute changes upstream instead. Repository-specific rules — stack,
structure, ownership, and conventions unique to this repo — live in this
directory.

Rules that turned out to be fully covered by the shared docs were removed rather
than duplicated, and now live upstream:

- transport lifecycle → [../rules/modules/transport.md](../rules/modules/transport.md)
- keep-alive policies → [../rules/modules/keep-alive.md](../rules/modules/keep-alive.md)
- generic type parameters → [../rules/conventions.md](../rules/conventions.md)
- one-primary-form / no duplicate APIs → [../rules/cleanliness.md](../rules/cleanliness.md)
- environment-variable rules → [../rules/codebase.md](../rules/codebase.md)
