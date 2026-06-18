# Local Rules

## Role

Repository-specific engineering rules for nexus-web. These complement the
shared, language-agnostic standards mirrored from the
[engineering-docs](https://github.com/NielsdaWheelz/engineering-docs) repo in
[../rules/](../rules/), which is kept in sync via `git subtree`.

## Documents

- [tech-stack.md](tech-stack.md): runtime and tooling stack.
- [codebase.md](codebase.md): repo structure, module ownership, and import specifics.
- [testing_standards.md](testing_standards.md): Nexus testing standards and test tiers.
- [typescript.md](typescript.md): repository-wide TypeScript type-shape rules.
- [environment.md](environment.md): environment variable rules.
- [entrypoints.md](entrypoints.md): entrypoints and side effects.
- [module-apis.md](module-apis.md): how modules expose capabilities.
- [transport.md](transport.md): transport lifecycle ownership.
- [keep-alive.md](keep-alive.md): keep-alive and connection reuse policies.

## Boundary

Shared, reusable engineering rules live in [../rules/](../rules/) and are
updated by pulling the engineering-docs subtree — do not hand-edit them here;
contribute changes upstream instead. Repository-specific rules — stack,
structure, ownership, and conventions unique to this repo — live in this
directory.
