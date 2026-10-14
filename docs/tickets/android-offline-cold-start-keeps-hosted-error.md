# offline cold start retains hosted error before downloads

status: open; downloaded copy remains usable through the native recovery action
origin: 2026-10-14 release acceptance, signed android0.3.0/code20, source58c7ecae6
area: android shell / offline startup

with wi-fi and mobile data disabled (both settings verified0), cold launch twice loaded the hosted origin and reached `net::ERR_NAME_NOT_RESOLVED` rather than opening the shelf automatically. the native “nexus could not connect” terminal offers “open downloaded copies”; that action opened the existing9.9KB keats article and its readable text offline. underlying webview error text also appears beneath the native terminal in accessibility output.

impact: an extra recovery action before offline reading; download integrity and explicit offline reading passed. automatic-shelf startup remains unqualified. source `MainActivity.kt:478` uses `hasValidatedNetwork` (`:697`), which trusts the active network VALIDATED capability. retained phone VPN may affect this classification; causality NOT_PROVED. no VPN settings were changed.

evidence: campaign `release/android-58c7ecae/device-installation/{offline-network-transition,offline-stable-cold-start}.json`, `offline-reader-open.xml`, `offline-stable-cold-ready.xml`. original wi-fi/mobile data were both1 and enable commands were issued afterward; final restoration verification follows.

next: capture the actual active network capability at cold start under the same phone/VPN state, then fix the startup/recovery owner if needed. do not weaken the shelf isolation boundary or require disabling the owner VPN.

acceptance: cold launch with both transports off reaches usable downloaded reading predictably; no hosted browser error bleeds through; reconnect and normal hosted navigation remain usable.
