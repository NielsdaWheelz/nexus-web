# contributor search after note visibility changes

an authored note containing a contributor embed can be deleted or revived without refreshing that viewer's materialized contributor keyword text.

`python/nexus/services/note_bodies.py:130` refreshes contributor text only when the embed set changes. `python/nexus/services/authored/projections.py` refreshes contributors only for explicit contributor links or retained x-post captures. a note visibility change with unchanged embeds meets neither condition. `python/nexus/auth/permissions.py:214` admits contributor identity through live edges, so this changes source admission while its keyword occurrence remains stale.

reproduce with a contributor having no other visible credit/root: create an embedded reference from a visible note, delete that note, then revive it; compare contributor keyword occurrence/admission with current visibility. fix at projection ownership using an indexed existence check for contributor note-body facts on visibility-changed notes. resolved when real postgres proves keyword publication follows both deletion and revival without scanning unrelated notes.
