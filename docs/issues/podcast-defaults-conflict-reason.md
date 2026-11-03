# podcast defaults conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: lib/podcasts/usePodcastSettingsSave.tsx79,93,110; components/player/GlobalPlayerSurfaces.tsx525-526; components/podcasts/PodcastSettingsOverlay.tsx108-109 derives `they changed elsewhere.` / `these defaults changed elsewhere.` from generic conflict/status. criterion 18 requires an owner proving the cause.

impact/counterexample: unchanged entity + owned database transaction busy. python/nexus/api/edge.py93-99 catches DatabaseBusyError and emits E_RESOURCE_CONFLICT. no changed entity is required. podcasts/settings.py67,71,88-101 combines id taken and settings version checks under E_RESOURCE_CONFLICT; edge-owned busy can return unchanged current pair. difference or another writer cannot be inferred merely from entering Conflict.

minimal proposed repair: retain Conflict reread and all save/review/check guards. owner Conflict tell keeps unsaved fact without cause. panel/dialog Review Conflict fact becomes `couldn’t save these defaults.`; ReadFailed Conflict same fact plus true `couldn’t load the current ones.` and existing check. Unknown-difference branch stays unchanged.

resolved when the generic-conflict counterexample produces no unproved changed/elsewhere cause while conflict safety remains intact. root owns repository adoption; this audit changed no product code and ran no lab.
