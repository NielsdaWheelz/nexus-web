# release shared outline editing

pair api and web in one release: full `ResourceAnnotationOut`, required nullable
reader continuation/placement, exact outline `insertion_source`, and `Relink.position` replace the previous wire
shapes. migration `0302_user_link_source`, after `0301`, replaces the user-link index with unordered pair uniqueness;
new links retain insertion orientation in existing columns. existing rows and
relationship meaning remain unchanged. no compatibility reader.

wire revision remains 13: the first breaking change since deployed revision 12
already allocated this release's bump. regenerate clients from this branch and
ship both sides together; older clients must receive the existing stale-wire
response. no production validation or deployment is authorized by this change.
the release controller must perform its existing migration ancestry, stopped-writer,
backup and exact-head checks before the paired release. production-backup rehearsal
remains owed before release; this change qualifies only isolated data, as the owner
requested. do not treat fresh-database migration proof as historical-data rehearsal.

resolved when the paired api/web release is deployed with revision 13 and the
release owner confirms the existing wire preflight.
