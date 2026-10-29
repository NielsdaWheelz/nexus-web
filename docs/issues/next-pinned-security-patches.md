# assess security patches after pinned next 15.5.22

`apps/web/package.json` and its lock pin next and eslint-config-next 15.5.22.
official subsequent 15.5 releases include security fixes: 15.5.24 image
optimization/windows-server advisories, 15.5.27 metadata/cache-poisoning
advisories, and 15.5.28 svg image optimization and server-actions advisories.
applicability is partially assessed below; generated-build and runtime
qualification remain open. no exploit or production probe was performed.

the package also explicitly overrides `sharp` to `0.35.0`, which the lock resolves.
upgrading next alone may retain that dependency; review the override and actual
resolved platform packages alongside the framework update.

source/package review at `96a3b7bdf`: next 15.5.28 and sharp 0.35.5 are the
compatible proposed targets. published next commonjs/esm response sending still
needs nexus's existing header patch. no server-action declarations or dynamic
metadata restrictions were found; all 36 optimizer-allowed plates are jpg.
the root catch-all page exists, so ssg/isr applicability needs generated-build
inspection rather than a blanket source-only waiver. these findings are not
exploit, install, build or runtime qualification.

sources: [15.5.24](https://github.com/vercel/next.js/releases/tag/v15.5.24),
[15.5.27](https://github.com/vercel/next.js/releases/tag/v15.5.27),
[15.5.28](https://github.com/vercel/next.js/releases/tag/v15.5.28).

resolve by assessing those advisories against actual deployed capabilities and
upgrading the pinned compatible framework/tooling where required, then running
the canonical static checks and affected real journeys. this is separate from
route-handler compression: source through 15.5.28 still contains that defect.
