# unavailable focus-note delivery

`LocalOutline.focusNote()` previously returned a boolean while asynchronously opening off-window content; absent/deleted targets could leave the page's mutation observer waiting without a claimed unavailable result.

implemented: one abortable `Promise<boolean>` checks permanent membership and target liveness, opens a bounded window, and resolves only after its actual editor mounts and focuses. the page claims false as unavailable; read failures reject visibly. the outline owns and disconnects the local mount observer and cancels superseded/unmounted requests.

pending proof: mounted live off-window targets focus without prefix traversal; absent/deleted targets settle, and canceled deliveries never steal focus.
