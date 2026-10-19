# daily refusal recovery can retain expected missing-resource errors

first-day materialization refusal starts resource reloads beside a daily refetch.
the daily response can restore a local draft before a resource reload installs
an expected 404. insertion and draft navigation then remain unavailable.

evidence: `apps/web/src/lib/notes/useOutline.ts:251` reloads every graph ref;
line 129 retains failures. lines 399–409 restore the synthetic daily draft from a
successful daily read. insertion correctly rejects retained 404s at lines 478–483.
source-traced existing recovery ordering defect; not browser-reproduced.

repair daily recovery ordering so those specific resource reads finish or are
superseded before restoring the synthetic draft. clear only its expected missing
resource errors; preserve access and stale-wire failures. do not merely clear
errors while older reads can reinstall them.

resolved when a refused first materialization recovers with resource replies both
before and after the daily reply, and the restored draft supports expand, focus
and insertion without a reload of the application.
