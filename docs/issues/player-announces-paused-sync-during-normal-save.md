# player announces paused sync during a normal save

status: open · origin: 2026-10-15 final `fdd0a3e` phone acceptance · area: playback / accessibility

starting episode 113 produced the aria-live announcement “progress sync paused”.
the full paused player later showed no error or retry notice. three listening
puts returned 200 and two activity posts returned 204 between 21:54:45 and
21:55:07 utc; this evidence does not establish a failed upload.

`apps/web/src/components/player/GlobalPlayerSurfaces.tsx:229` treats every
`synced=false` as paused. its effect at line 297 retains the last nonempty
announcement when sync recovers. native `ListeningRecorder.kt:245,281,294`
sets false while an ordinary queued write drains, then true on completion.
the status conflates normal delivery with a blocked queue and can leave stale
accessibility feedback.

evidence: private campaign `coordinator/finalfdd0a3e/phone-sync-diagnosis/api-observation-1.json`;
the phone owner's actual playback and queue receipts remain the runtime authority.
reproduce by starting playback with a healthy connection and observing the live
region during a normal progress save.

fix the existing player status owner: distinguish pending delivery from a
paused/refused queue and clear or replace the announcement on recovery. reuse
the recorder's actual delivery state; do not infer failure from pending work.

acceptance: normal successful progress writes never announce a false pause;
a real retained failure remains visible and accessible, and successful recovery
removes stale failure feedback without losing queued progress.
