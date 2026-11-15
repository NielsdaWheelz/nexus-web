# memory image qualification

status: linux/arm64 source qualification passed, 2026-11-14; deployment-platform
qualification remains open. [owning issue](https://github.com/NielsdaWheelz/nexus-web/issues/571).

anonymous no-cache api, worker and worker-checkout builds of application
`12f74c865eb289e186ff33b310f8d34a28c9220d` passed on linux/arm64. runtime inspection
verified locked dependencies, non-root execution and schema/source identity where
embedded; worker-checkout receives application source by mount. image-layer,
output and environment checks found no task memory credentials. composed mounts
keep the client on api/interactive and upload on background. exact image ids and
evidence are in the [capture handoff](release-memory-capture.md).

the local amd64 build failed with `exec format error`; no emulation was installed
and no remote docker service was started. arm64 proof does not qualify the
intended amd64 deployment host.

resolved when the selected source/lock builds on the deployment architecture and
its image digests, runtime identities and private mounts are verified. retain
anonymous immutable dependency fetch; do not restore retired deploy keys or
build-secret plumbing. installed activation remains a separate stopped release
under the [capture handoff](release-memory-capture.md).
