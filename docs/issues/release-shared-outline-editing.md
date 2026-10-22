# release shared outline editing

pair api and web in one release: full `ResourceAnnotationOut`, required nullable
reader continuation/placement, exact outline `insertion_source`, and `Relink.position` replace the previous wire
shapes. new links retain insertion orientation in existing columns. existing rows and
relationship meaning remain unchanged. no compatibility reader.

wire revision remains 13: the first breaking change since deployed revision 12
already allocated this release's bump. regenerate clients from this branch and
ship both sides together; older clients must receive the existing stale-wire
response. no production validation or deployment is authorized by this change.

resolved when the paired api/web release is deployed with revision 13 and the
release owner confirms the existing wire preflight.
