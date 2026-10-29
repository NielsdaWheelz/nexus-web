# chat context paired assets

chat context adds the shared `highlight_notes` sql query. android accepts only
query hashes packaged with its installed assets (`apps/web/vite.android.config.ts`;
`apps/android/app/src/main/java/app/nexus/android/authored/AuthoredStore.kt`).

build and install matching web/android assets before release. qualify the full
all-note result on the disposable installed package, including more than 100
notes and local link changes. no database migration or wire revision change.

resolved when the paired release is installed and the real native query succeeds;
implementation qualification is recorded in the change's pr, not here.
