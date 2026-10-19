# reader navigation talkback spoken announcement unverified

status: open; origin: 2026-09-26 reversible reader navigation device acceptance; area: android accessibility

on the final task-owned apk, the held-position status and `aria-live=polite` text appeared in the android accessibility tree. talkback took audio focus and google tts synthesized after activation, but the available logs did not include utterance text. the exact spoken announcement therefore remains unverified; tree presence and tts activity do not prove its words or timing.

prerequisite: a task-owned device or emulator with observable talkback audio. acceptance: hear or record the exact held-position, unavailable-origin, and remote-spot announcements once each after their state changes; confirm that ordinary scrolling causes no repeated announcement and that the compact return action remains reachable. restore the device's prior accessibility setting afterward.
