# firefox tab background has no live continuation verdict

the headless firefox run `20261124-011737-968c88e62323` held a browse continuation,
opened a second tab and brought it forward. the source tab still reported
`document.visibilityState === "visible"`. the test therefore did not exercise
the browser visibility fence in `lib/api/useServerList.ts`.

recheck with a firefox run that observes the source tab become hidden while the
continuation response is held. release it, restore the tab and verify that the
accepted rows remain and no next cursor is requested until forward travel or a
continuation action. keep the visibility transition, request counts and source
revision in the evidence.
