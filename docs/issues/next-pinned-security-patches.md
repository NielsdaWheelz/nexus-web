# assess security patches after pinned next 15.5.22

`apps/web/package.json` and its lock pin next and eslint-config-next 15.5.22.
official subsequent 15.5 releases include security fixes: 15.5.24 image
optimization/windows-server advisories, 15.5.27 metadata/cache-poisoning
advisories, and 15.5.28 svg image optimization and server-actions advisories.
applicability to this application's configuration and deployment is unassessed;
no exploit or production probe was performed.

sources: [15.5.24](https://github.com/vercel/next.js/releases/tag/v15.5.24),
[15.5.27](https://github.com/vercel/next.js/releases/tag/v15.5.27),
[15.5.28](https://github.com/vercel/next.js/releases/tag/v15.5.28).

resolve by assessing those advisories against actual deployed capabilities and
upgrading the pinned compatible framework/tooling where required, then running
the canonical static checks and affected real journeys. this is separate from
route-handler compression: source through 15.5.28 still contains that defect.
