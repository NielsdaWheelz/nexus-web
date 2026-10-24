# writing receive release

release remains separate from this implementation. ship the web and api changes
through the existing release owner. no wire revision, schema migration, environment
change or data conversion is required. installed clients receive the new web ui
through their ordinary apk packaging; do not add a compatibility path.

after release, use the affected authenticated production firefox session to
capture the original reload and confirm quiet healthy startup, neutral automatic
recovery, and effective stopped-stream retry. make no deliberate production fault
injection or scenario writes. the original failure remains tracked in
[production diagnosis](writing-receive-warns-during-recovery.md).

resolved when release and that production check are complete.
