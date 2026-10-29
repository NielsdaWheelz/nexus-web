# compatible framework security update

investigated planning draft, 2026-10-28; pr 6 of the release repair scope.
source inspected: `96a3b7bdf`. published for review at the owner's request. specification only;
no dependency, lock, application or deployment change has been made.

## outcome and known evidence

ship a supported compatible framework/dependency cohort containing the applicable
security fixes while preserving nexus's serving, auth and streaming contracts.
`apps/web/package.json` pins next and eslint-config-next 15.5.22 and explicitly
overrides sharp to 0.35.0; the lock resolves that override. updating next alone
may therefore retain the vulnerable dependency.

registry metadata currently identifies 15.5.28 as the newest stable 15.5 next
and eslint-config-next release; sharp's stable release is 0.35.5. the published
next 15.5.28 package permits sharp `^0.34.3 || ^0.35.5`. its commonjs and esm
`send-response.js` still contain the singleton-header append behavior that
nexus patches. source comparison establishes the patch remains needed; no
install, patch application, build or runtime proof was performed.

## advisory applicability

these are source/configuration assessments, not exploit demonstrations. official
advisories are linked below; no hostile request was sent to production.

| advisory | inspected nexus boundary | assessment |
| --- | --- | --- |
| windows-hosted server execution, fixed 15.5.24 | production frontend is vercel; supported standalone environments are mac/linux | no identified windows deployment; do not claim a windows capability |
| avif optimizer execution, fixed 15.5.24 | optimizer permits only local `/oracle-plates/**`; all 36 current plate files are jpg | no identified attacker-supplied avif path; package fix still included |
| dynamic metadata image parameters, fixed 15.5.27 | metadata images are root `opengraph-image.tsx` and `apple-icon.tsx`; no `generateStaticParams`/`dynamicParams` declarations found | no identified affected dynamic metadata restriction |
| pages-router ssg/isr cache substitution, fixed 15.5.27 | app router only; production hosted on vercel | advisory's pages-router/self-hosted combination not identified |
| root catch-all ssg/isr cache poisoning, fixed 15.5.27 | `(authenticated)/[[...path]]/page.tsx` exists; root viewport reads cookies; no explicit ssg/isr declarations found | catch-all premise exists; final build/cache applicability remains unproved, so do not waive it |
| svg optimizer execution, fixed 15.5.28 | same local jpg allowlist; sharp override 0.35.0 | no identified untrusted svg optimization path; native dependency is nevertheless pinned below the advisory's stated workaround |
| server-action denial of service, fixed 15.5.28 | no `use server` declarations found; configuration alone does not create an action | source premise not identified; inspect generated action manifest when building |

## owners, scope and invariants

- package/lock/override ownership: `apps/web/package.json`, `apps/web/bun.lock`.
  review `next.config.ts`, middleware/security owners and both production
  serving paths, including the standalone tls/http2 runtime.
- the local `patches/next@15.5.22.patch` changes response header handling in both
  commonjs and esm outputs: singleton headers use `setHeader`; cookies and
  supported multi-value headers retain append behavior. do not drop or blindly
  transplant it during upgrade; determine whether upstream now owns the fix.
- preserve exact source identity, auth cookies/redirects, private cache policy,
  compression/header behavior, streaming/cancellation and packaged build output.
- retain locked reproducible installs and align compatible framework tooling.
  review the explicit sharp override and actual platform dependency resolution,
  not only the version requested by next.

## recommended change and remaining decisions

pin next and eslint-config-next to 15.5.28; move the existing sharp override to
0.35.5 and regenerate the lock through the locked package manager. retain an
explicit sharp floor here because the current override defeats transitive fixes
and the target next range alone is wider than the inspected 0.35.5 fix. recheck
official releases when implementation starts; a newer patch requires assessment,
not an automatic major upgrade.

rebase the local patch onto `next@15.5.28`, retaining only its existing two-output
header correction, then delete the superseded patch entry/file. preserve cookies
and supported multi-value headers. strongest reason to reject this choice:
patching framework internals carries maintenance and could conflict with changed
serving code. address that with exact target-source review and focused serving
proof; retiring the patch now would restore an observed defect.

the smallest decisive experiment is a frozen install/build in a dedicated
checkout, inspect resolved sharp/platform packages and generated prerender/action
manifests, then exercise singleton/multiple headers and a compressed streaming
response through the canonical tls/http2 runtime. that proves the risky boundary
before replaying broader user journeys. no broad dependency refresh is needed.

remaining unknowns: the exact generated static/action surface, native sharp
packaging on deployed linux, and final patch/build/runtime behavior. package
metadata and source comparison do not establish any of those passes.

## acceptance, costs and dependencies

inspect the resolved lock/platform artifacts, run `./scripts/test`, and build
the canonical production package. use focused real journeys for auth/session
renewal, redirects/cookies, image reads, compressed responses, streaming and
cancellation. qualify standalone tls/http2 and the matching staged hosted build;
preserve source/version identity. follow [verification rules](local-rules/testing-standards.md).

costs: dependency churn, possible patch maintenance and targeted regression work.
this pr can proceed independently; qualification binds to the final integrated
release. no framework patch is claimed applied or tested by this stub.

issue owner: [security assessment](issues/next-pinned-security-patches.md).
primary sources checked in the investigation:
[next package](https://registry.npmjs.org/next/15.5.28),
[sharp package](https://registry.npmjs.org/sharp/0.35.5),
[windows advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36),
[avif advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
[metadata advisory](https://github.com/vercel/next.js/security/advisories/GHSA-f87g-xv8r-7p7x),
[pages cache advisory](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676),
[catch-all cache advisory](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p),
[15.5.28](https://github.com/vercel/next.js/releases/tag/v15.5.28),
[svg optimizer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw),
[server-action advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r).
