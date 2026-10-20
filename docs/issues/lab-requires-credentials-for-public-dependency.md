# lab requires credentials for a public dependency

status: open; infrastructure follow-up outside palette/opening implementation
origin: 2026-10-20 live qualification

github's repository api reports `NielsdaWheelz/universal-memory` as public
(`private: false`). local runtime/build docs still call it private, require
`UNIVERSAL_MEMORY_DEPLOY_KEY_FILE`, and force authenticated ssh through
`scripts/with-memory-git`. evidence: `python/scripts/disposable_runtime.py:376-378`,
`docker/Dockerfile.backend:16-18,32-34`, and
`docs/issues/release-local-runtime.md:24-26`.

impact: real disposable verification requires a deploy-key lifecycle even
though dependency reads no longer need private-repository access. the owner
approved a temporary read-only key for current qualification; revoke and remove
it after use. do not substitute a dummy key or bypass the lab's preflight.

proposed fix: independently reconcile dependency visibility with build, lab,
ci and documentation owners; retain locked revisions and authenticated fetch
only where a dependency actually requires it. no infrastructure rewrite here.

resolved when a locked dependency install and fresh lab build work without a
credential for this public repository and all active docs reflect that contract.
