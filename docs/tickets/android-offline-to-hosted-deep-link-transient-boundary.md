# android offline-to-hosted deep link briefly failed

status: open; origin: 2026-09-26 reader navigation final-apk acceptance; area: android workspace / offline shelf

on task emulator-5560, the first deep link from the offline shelf to freshly uploaded article `01a0e111-1fb8-7b46-9dbb-097bfa891a00` showed a workspace load boundary and `Offline reading is unavailable / could not reach offline reading`; the next route load after home navigation succeeded and downloaded the article. the isolated web login route returned 200 and api health returned its expected authenticated 401. the precise cause remains unproven; this may be adb reverse or network-transition timing rather than product behavior.

prerequisite: preserve the debug apk, adb reverse and network-state receipts. acceptance: repeat offline shelf → hosted article deep links across cold launch and airplane/reconnect on an identified apk. either show that the first failure was a documented setup transition or reproduce and repair its owning app boundary; the route must load without a manual home detour under a valid connection.
