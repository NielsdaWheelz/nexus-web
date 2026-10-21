# native timeout warning lacks physical display qualification

problem: the real native deadline and recovery are qualified, but physical
warning presentation remains unverified. stopping the entire owned android
process also stops its display host; the renderer can update while the handset
retains its last composed frame. this probe establishes no display defect.

evidence: source `813341ccbb`, run `20261021-150232-915b7e2cfa28`, isolated
`app.nexus.android.persistentplayer.debug`, webview `155.0.8059.43`. an actual
pause request timed out after 5.383s; renderer DOM and its one live region said
`player unavailable`. resuming recovered the same source without a new-play
announcement. private `native-timeout-device.png` still shows loaded controls.

resolved when a real native request can time out while the display host keeps
composing, and the handset visibly shows the warning and subsequent recovery.
keep this separate from the already qualified native state transition.
