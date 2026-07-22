# E-Ink Reader Prototype

Status: research decision record; not implemented
Last surveyed: 2026-07-20

## Decision

- Build an **e-ink appliance client for Nexus**, not a Nexus port.
- Keep the hosted web app, BFF, API, auth, content, progress, and chat unchanged.
- Run Chromium fullscreen on the device; do not install Next.js, FastAPI, or
  internal credentials locally.
- Keep all future work in this monorepo: presentation changes in `apps/web`,
  with an optional `apps/eink-device` or `deploy/eink` only after the prototype
  proves a device shell is needed.
- Make v0 online-only, portrait, monochrome, and reading-first.
- Let the device display layer—not React—own dirty regions, waveform selection,
  temperature/VCOM behavior, ghosting, and full-screen cleaning.

The 80/20 prototype is the current mobile reader in a Chromium kiosk on complete
e-ink hardware. The long-term product is the same web product above a narrow
e-ink presentation contract and a proper display HAL.

## Why the existing app fits

- The browser is already a thin client behind the hosted BFF/API boundary:
  [`architecture.md`](architecture.md#9-frontend-architecture).
- Mobile already has a one-pane, full-width composition rather than a narrow
  desktop layout: [`modules/workspace.md`](modules/workspace.md).
- Articles and EPUBs use a touch-capable, single-column, reflow-safe reader;
  PDFs use PDF.js: [`modules/reader-implementation.md`](modules/reader-implementation.md).
- Canonical reflow locators allow screenful navigation without replacing
  progress/resume semantics.
- The Android WebView shell is the precedent: native code owns shell mechanics,
  while Nexus product behavior remains web-owned.
- The authenticated initial-route bundle measured 103.1 kB gzip against the
  115 kB budget on 2026-07-17; bundle size is not the first constraint.

Current gaps:

- `RenderEnvironment` knows platform plus `desktop | mobile`, but not e-ink or
  appliance capabilities.
- A 1404 px portrait panel appears desktop unless output/browser scale makes
  the CSS viewport at most 768 px; desktop-first hydration can cause a ghosting
  flash.
- The visual system assumes an emissive display: color, shadows, translucency,
  fades, hover, animation, and continuous scrolling.
- The app is online-first. The manifest is not an offline reader; authenticated
  bootstrap, signed media URLs, progress writes, and SSE require connectivity.
- Chromium is the only browser engine covered by the current browser/E2E lanes.

## Target hardware

Preferred screen:

- 10.3 inch, portrait, 1872x1404 (~227 PPI)
- monochrome
- factory-bonded capacitive touch
- factory-integrated dual-temperature frontlight
- known controller/TCON, supplied waveform package, VCOM data, and temperature
  support
- preferably flexible/Mobius substrate
- two physical page buttons plus power

Avoid color until it is proven necessary. Six inches is cramped for Nexus and
PDFs; 13.3 inches is a desk/lap reader rather than a normal handheld.

Practical paths:

| Stage | Hardware | Use | Caveat |
| --- | --- | --- | --- |
| Touch UX mule | PineNote Community Edition | Fastest complete 10.3-inch Linux touch/frontlight/battery test | Beta display stack; production halted and remaining stock finite |
| Display lab | Pi 4, 4 GB + Waveshare 10.3-inch IT8951 HAT | Learn damage, partial/quality refresh, cleaning, and ghosting | No touch/frontlight; SPI/IT8951 is not a normal HDMI/DRM display |
| Browser bench | Pi 5, 2–4 GB + supported monitor | Easy Chromium/PDF profiling | Cooling and power make it a poor Kindle-like mainboard |
| Portable v1 | CM4, 4 GB, Wi-Fi, eMMC + bonded 10.3-inch touch/frontlight stack | Reproducible custom appliance | Real electrical, mechanical, kernel, power, and procurement project |

Use CM5 only if profiling shows CM4 is insufficient. Do not use Pi Zero 2 W for
the local Chromium route. ESP32-class hardware can be a display coprocessor, not
the Nexus runtime.

Never buy a raw panel without its exact controller, waveform/LUT, VCOM,
temperature, touch, frontlight, power-sequencing, and Linux integration path.

## Ownership boundary

```text
Hosted Nexus
  auth, content, progress, highlights, chat
            |
Nexus web presentation
  standard / mobile / eink-appliance
            |
Chromium first; WPEPlatform only after compatibility proof
            | compositor damage
E-ink display daemon / HAL
  coalescing, fast/quality/clean modes, temperature, ghosting
            |
TCON + PMIC + VCOM + panel

Touch   -> evdev/libinput -> browser
Buttons -> page-turn input
Power   -> suspend, charger, fuel gauge, recovery
```

React may publish semantic intent such as `interactive`, `settled`, or
`page-turned`; it must not name vendor waveform modes. Prefer compositor damage
and debounce. Any semantic device API must be small, typed, versioned, and
architecture-reviewed—not a general JavaScript bridge.

## Minimal future app slice

1. Add a **per-device**, server-seeded capability adjacent to
   `RenderEnvironment`, conceptually covering surface, display, motion, and
   input. Do not store e-ink as the user's global reader theme.
2. Add an `eink-appliance` workspace composition that reuses the existing pane
   bodies, especially `MediaPaneBody`; do not build another reader or parallel
   route/data model.
3. Apply one centralized e-ink projection:
   - light, high-contrast monochrome;
   - solid borders instead of shadows/transparency;
   - no grain, blur, fades, smooth motion, hover dependency, or reactive chrome;
   - no color-only meaning; use labels, icons, underlines, patterns, and rules;
   - crisp text, dithered images, 44–52 px touch targets.
4. Add instant screenful forward/back navigation and edge tap zones while
   preserving the continuous document and canonical locator underneath. Use
   page-at-a-time PDF presentation and support physical page buttons.
5. Coalesce visually noisy updates. Chat may receive token-level SSE but should
   repaint completed phrases/sentences/blocks on e-ink.
6. Treat offline reading as a separate capability: authorized revision manifest,
   asset storage/eviction, progress/highlight outbox, idempotency, conflicts,
   revocation, quotas, and optional encryption. A service worker alone is not it.

## Prototype stack

- Debian or Raspberry Pi OS
- minimal Wayland session
- Chromium kiosk/app mode with a dedicated persistent profile
- portrait output and approximately 2x device scale, yielding ~702 CSS px on a
  1404 px-wide panel and therefore selecting the existing mobile composition
- Nexus light theme and reduced motion
- normal first-party login; never bake a session token into the image
- systemd autostart/watchdog and a recovery console
- Wi-Fi, wall power or protected USB power bank; no custom Li-ion pack yet

Chromium remains first because it is what Nexus proves. WPE is a credible later
embedded runtime, but validate cookies, CSP/auth redirects, PDF workers/canvas,
selection, observers, streams/SSE, and dynamic imports first. Do not start new
work on Cog; current WPE guidance is WPEPlatform.

For a reproducible product image, move later to Buildroot or Yocto plus signed,
rollback-capable A/B updates such as RAUC. That is not v0 work.

## Sequence and gates

1. Fix v0 scope: online, portrait, monochrome, article/EPUB first, PDF as stress
   test, no pen, no custom battery, no multi-week standby claim.
2. Run unchanged production Nexus on complete e-ink hardware.
3. Configure kiosk, scale, login persistence, buttons, watchdog, and recovery.
4. Implement only the typed capability, visual projection, and screenful turns.
5. Build the IT8951/display-HAL lab if custom display ownership is still wanted.
6. Select bonded panel/controller and portable electronics only after measurement.

Required validation:

- cold boot through authenticated library and reader
- no desktop-to-mobile first-paint flash
- article/EPUB selection, highlights, progress, and reboot resume
- PDF worker startup, range fetch, zoom, selection, and memory
- session refresh, Wi-Fi loss/reconnect, SSE, and signed media access
- 50–100 page turns with documented ghosting/cleaning behavior
- touch latency, accidental gestures, idle/turn power, sleep/wake, and thermals
- recovery when the browser, update, or display path fails

## Explicit non-goals for v0

- no new repository, backend, or native Nexus clone
- no local Next.js/FastAPI/Postgres deployment
- no raw-panel-first build
- no custom PCB, battery pack, or enclosure before UX/display proof
- no offline subsystem
- no color e-paper
- no WPE/WebKit migration before Chromium proof
- no attempt to expose every Nexus surface; make a reader/queue/highlights/quiet-AI
  appliance, not a grayscale twelve-pane workspace

## Questions before portable v1

- Articles/EPUB or full-page PDFs as the primary workload?
- Finger touch only, or pressure-sensitive pen?
- Is frontlight mandatory?
- Battery target: hours, days, or weeks? Required wake time?
- Offline requirement and storage size?
- Acceptable size, weight, and one-handed width?
- One artifact or a reproducible design?
- Who owns waveform redistribution and long-term panel/controller supply?
- What is the recovery path when the display cannot show boot diagnostics?

## Time-sensitive sources

- [PineNote product](https://pine64.com/product/pinenote-community-edition-coming-soon/),
  [development status](https://pine64.org/documentation/PineNote/Development/),
  and [2026 production update](https://pine64.org/2026/03/24/march_2026_fosdem/)
- [Waveshare 10.3-inch IT8951 HAT](https://www.waveshare.com/10.3inch-e-paper-hat.htm)
- [Good Display 10.3-inch touch/frontlight panel](https://buy-lcd.com/products/gdep103tc2-ft11)
  and [TCON](https://buy-lcd.com/products/deja-tc103)
- [Raspberry Pi Compute Modules](https://www.raspberrypi.com/documentation/computers/compute-module.html)
- [WPE WebKit](https://webkit.org/wpe/) and
  [WPEPlatform/Cog status](https://wpewebkit.org/blog/2026-03-18-wpewebkit-2.52.html)
- [Buildroot](https://buildroot.org/), [Yocto](https://www.yoctoproject.org/),
  and [RAUC](https://rauc.readthedocs.io/en/latest/basic.html)
