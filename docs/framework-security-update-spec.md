# compatible framework security update

release scope 6 contract; investigated 2026-10-28 against `96a3b7bdf`, selected
for implementation 2026-10-29. the remaining deployed-artifact qualification
belongs to [release gates](issues/release-framework-security.md).

## outcome and known evidence

ship a supported compatible framework/dependency cohort containing the applicable
security fixes while preserving nexus's serving, auth and streaming contracts.
`apps/web/package.json` selects next and eslint-config-next 15.5.28 and explicitly
overrides sharp to 0.35.5. the previous 0.35.0 override would retain an older
native dependency even when next changed.

registry metadata checked for implementation identifies the selected compatible
cohort as next/eslint-config-next 15.5.28 and sharp 0.35.5. the published
next 15.5.28 package permits sharp `^0.34.3 || ^0.35.5`. its commonjs and esm
`send-response.js` still contain the singleton-header append behavior that
nexus patches. source comparison establishes the patch remains needed; package
metadata alone does not establish build or runtime correctness.

## advisory applicability

these are source/configuration assessments, not exploit demonstrations. official
advisories are linked below; no hostile request was sent to production.

| advisory | inspected nexus boundary | assessment |
| --- | --- | --- |
| windows-hosted server execution, fixed 15.5.24 | production frontend is vercel; supported standalone environments are mac/linux | no identified windows deployment; do not claim a windows capability |
| avif optimizer execution, fixed 15.5.24 | optimizer permits only local `/oracle-plates/**`; all 36 current plate files are jpg | no identified attacker-supplied avif path; package fix still included |
| dynamic metadata image parameters, fixed 15.5.27 | metadata images are root `opengraph-image.tsx` and `apple-icon.tsx`; no `generateStaticParams`/`dynamicParams` declarations found | no identified affected dynamic metadata restriction |
| pages-router ssg/isr cache substitution, fixed 15.5.27 | app router only; production hosted on vercel | advisory's pages-router/self-hosted combination not identified |
| root catch-all ssg/isr cache poisoning, fixed 15.5.27 | `(authenticated)/[[...path]]/page.tsx` exists; root viewport reads cookies; no explicit ssg/isr declarations found | catch-all premise exists; qualify the release artifact's prerender surface rather than waiving it from source alone |
| svg optimizer execution, fixed 15.5.28 | same local jpg allowlist; previous sharp override 0.35.0 | no identified untrusted svg optimization path; the selected native dependency includes the stated workaround |
| server-action denial of service, fixed 15.5.28 | no `use server` declarations found; configuration alone does not create an action | source premise not identified; inspect generated action manifest when building |

## owners, scope and invariants

- package/lock/override ownership: `apps/web/package.json`, `apps/web/bun.lock`.
  review `next.config.ts`, middleware/security owners and both production
  serving paths, including the standalone tls/http2 runtime.
- the local `patches/next@15.5.28.patch` changes response header handling in both
  commonjs and esm outputs: singleton headers use `setHeader`; cookies and
  supported multi-value headers retain append behavior. do not drop or blindly
  transplant it during upgrade; determine whether upstream now owns the fix.
- preserve exact source identity, auth cookies/redirects, private cache policy,
  compression/header behavior, streaming/cancellation and packaged build output.
- retain locked reproducible installs and align compatible framework tooling.
  review the explicit sharp override and actual platform dependency resolution,
  not only the version requested by next.

## selected change and trade-off

next and eslint-config-next move together to 15.5.28; the sharp override moves
to 0.35.5. retain the explicit sharp floor: next permits older sharp versions
as well. the locked package manager owns dependency resolution. this is a
compatible security update, with no major upgrade or broad dependency refresh.

the local patch moves to `next@15.5.28` byte for byte and the superseded entry
and filename are removed. patching framework internals carries maintenance cost
and can conflict with changed serving code. exact target-source review and
focused serving qualification justify retaining the narrow correction; retiring
it while both upstream writers still append singleton headers restores the defect.

## acceptance, costs and dependencies

inspect the resolved lock/platform artifacts, run `./scripts/test`, and build
the canonical production package. use focused real journeys for auth/session
renewal, redirects/cookies, image reads, compressed responses, streaming and
cancellation. qualify standalone tls/http2 and the matching staged hosted build;
preserve source/version identity. follow [verification rules](local-rules/testing-standards.md).

costs: dependency churn, possible patch maintenance and targeted regression work.
this pr can proceed independently; qualification binds to the final integrated
release. proof and its limits belong in the pr body, rather than this contract.

issue owner: [release qualification](issues/release-framework-security.md).
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
