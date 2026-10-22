# shared podcast placement does not grant episode access

a member can see a podcast filed in a shared library while lacking access to
its episodes if those episodes have no separate grant or direct placement in
one of that member's libraries. this contradicts inherited placement as an
effective content-membership contract.

evidence: `python/nexus/auth/permissions.py:148-162` grants show visibility
through library membership; `:111-145` roots media access in direct media
entries and other grants, without expanding filed podcasts into episodes.
`python/nexus/services/library_entries.py:67-103` models episodes as inherited
through the show. the disposable two-viewer qualification confirms the member sees the show
but gains no episode access solely through it.

resolve in the authorization relation together with the inherited-membership
contract. retain member checks, per-viewer tombstones and teardown exclusion;
do not grant every globally catalogued episode solely because a show id exists.
this is outside the immediate single-user presentation change.

acceptance: a second member of a library containing a podcast can read its
intended inherited episodes; a nonmember cannot; leaving the library removes
that access unless another independent grant remains.
