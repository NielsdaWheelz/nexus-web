status: open; reviewed transfer/close ownership integrated, verification pending
origin: 2026-09-14 peer review of publication asset streaming proposal
area: public PDF transfer admission and storage response ownership

`python/nexus/api/routes/public_resource_shares.py:18` uses an ordinary router;
its `/file` response at 181 has no transfer capacity/deadline owner. the current
StreamingResponse also does not explicitly close its supplied storage iterator
on early retirement (see immutable-member-stream-close-ownership.md).

scope correction: installed Uvicorn advertises ASGI 2.3 (h11_impl.py:205 and
httptools_impl.py:227). Starlette's response takes an AnyIO child-task-group
branch there, which drains children during raw parent cancellation. the earlier
claim that Uvicorn cancellation necessarily abandons a pending storage next was
too broad. Starlette's ASGI 2.4 direct-stream branch lacks that task-group owner;
that library branch is not evidence of a deployed failure here.

attach the existing package-transfer admission to this one file route. preserve
public security/error headers, authorization and ranges. share the existing
transfer pool and acknowledge that an offline download may make a public file
return 503. no new limits, registry or lifecycle framework. the source/proof
option and explicit close owner are now integrated after independent review.

acceptance: the actual public route, current production ASGI 2.3, and a held SDK
read establish capacity refusal, lightweight-read progress and caller completion
after physical next; explicit close must occur once. retain exact full/range
bytes and public headers. test deadline/disconnect close with the shared response
owner, and qualify transfer throughput separately. no runtime claim from this audit.
