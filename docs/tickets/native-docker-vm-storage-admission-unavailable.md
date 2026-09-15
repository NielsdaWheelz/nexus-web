# native Docker VM storage admission is unavailable

- status: open
- origin: 2026-09-14, pre-243 product restoration
- area: local test resource admission

`python/nexus_test_control/storage.py` asks the verified local Docker daemon for
`DockerRootDir`, then resolves that directory on the host and reads its free
space. This preserves bridge commit `8a67f6f23074835d86aed3f6531c1d12c6416f6b`'s
strict 8,192 MiB admission contract on Linux. With Docker Desktop or Colima on
macOS, that path belongs to the Linux VM and is not a host filesystem path.
Native runtime proof therefore receives unknown storage and fails closed.
Host disk free space alone cannot establish free space inside the VM.

run the repository-owned restoration proof on the authoritative linux devbox
under the latest instruction. A later native macOS implementation needs an owned, read-only way to
measure the daemon filesystem before allocating ordinary test resources; it
must not start unrecorded containers or substitute host free space for VM free
space. Otherwise declare the local Linux VM as the supported runtime execution
boundary and make the prerequisite diagnostic explicit.

acceptance: a native macOS invocation either measures both real write owners
and rejects an exhausted VM, or reports the supported local-VM route before
attempting runtime setup. Linux admission and the 8,192 MiB floor remain intact.
