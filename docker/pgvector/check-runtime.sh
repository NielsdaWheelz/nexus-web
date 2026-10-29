#!/bin/sh
# One image package proof for the unpatched pinned upstream candidate.
set -eu
test "$#" -eq 0
package=/usr/share/doc/pgvector
extension=/usr/share/postgresql/15/extension
library=/usr/lib/postgresql/15/lib

postgres --version
test "${PG_VERSION%%.*}" = 15
test "$(postgres --version | awk '{print $3}')" = "${PG_VERSION%%-*}"
test "$(dpkg-query -W -f='${Version}' postgresql-15-pg-search)" = 0.26.2
grep -Fx "default_version = '0.8.7'" "$extension/vector.control"
grep -Fx "default_version = '0.26.2'" "$extension/pg_search.control"
test -r "$library/pg_search.so"
test -r "$library/bitcode/vector.index.bc"
cd /
sha256sum -c "$package/nexus-package.sha256"
test "$(sha256sum "$library/vector.so" | cut -d ' ' -f 1)" = "$(sed -n 's/^binary_sha256=//p' "$package/nexus-build.txt")"
grep -Fx 'upstream_version=0.8.7' "$package/nexus-build.txt"
grep -Fx 'archive_sha256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85' "$package/nexus-build.txt"
grep -Fx 'patch=none' "$package/nexus-build.txt"
grep -Fx 'optflags=empty' "$package/nexus-build.txt"
grep -Fx "postgres_headers=$PG_VERSION" "$package/nexus-build.txt"
sha256sum "$library/vector.so" "$library/bitcode/vector.index.bc" "$library/pg_search.so"
cat "$package/nexus-build.txt"
printf 'postgres_package_capability=verified\n'
