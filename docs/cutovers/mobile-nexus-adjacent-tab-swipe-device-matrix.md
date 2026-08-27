# Mobile Nexus Adjacent-Tab Swipe — Physical Device Matrix

**Status:** PHYSICAL USB GATE PENDING · no operator outcomes recorded

**Owner:** Human operator on the USB-attested handset

This checklist owns only physical Android edge-conflict acceptance. The typed
workflow owns automated instrumentation evidence; the Chromium component proof
owns recognizer semantics. Neither can fill a human result below.

## Recording rules

- Replace `Pending` only with facts read back or directly observed on the bound
  USB handset at the candidate commit.
- Human result values are exactly `Pending`, `Pass`, or `Fail`. Typed-controller
  verdicts, including `not_run`, are never copied into a human result.
- A `Pass` row requires every diagnostic and observed-outcome cell in that row
  or its referenced configuration to be complete and reproducible.
- Preserve the exact selected `adb devices -l` row. Redact only unrelated host
  identifiers; do not remove the bound serial, `device` state, `usb:` topology,
  product/model/device facts, or transport id.
- Copy the typed command, bound serial, selected inventory row, and retained
  instrumentation diagnostics from the run's controller-owned
  `android-device-instrumentation.json`, never from terminal recollection. The
  artifact must bind the candidate SHA and exact Nexus proof, and contain
  `NEXUS_CONTROL_GESTURE_DIAGNOSTICS:`; it does not fill any human result.
- Preserve the full `adb devices -l` inventory alongside the selected row.
  Exactly one authorized `device` row may exist, and it must be the selected
  `usb:` row. A coexisting emulator or wireless transport invalidates the gate.
- Stop on an unreachable direction, missing WebView pointer stream, or any
  tap→switch, swipe→Nexus, Nexus→Back/Home, or Back/Home→Nexus ambiguity. Do not
  add an exclusion rectangle, native bridge, or inset schema to make a row pass.

## Candidate and USB binding

| Field | Recorded value |
| --- | --- |
| Date/time and timezone | Pending |
| Operator | Pending |
| Candidate commit (exact SHA) | Pending |
| Typed workflow command | Pending |
| Typed workflow run id | Pending |
| Typed workflow verdict (controller-owned) | Pending controller execution |
| Bound serial | Pending |
| Exact selected `adb devices -l` USB topology row | Pending — paste the exact selected row here |
| Device manufacturer/model | Pending |
| Android release / SDK / build fingerprint | Pending |
| System WebView package and exact version | Pending |
| App package/version under test | Pending |
| Automated instrumentation artifact | Pending — `test-results/runs/<run-id>/android-device-instrumentation.json` |
| Additional operator artifact references | Pending |

## Configuration diagnostics

Capture a fresh row after each orientation, navigation-mode, or sensitivity
change. Sensitivity is still read back under three-button navigation even when
the active mode does not consume it.

For each row, first preserve these bound-serial reads in the additional
operator artifact:

```sh
adb -s "$ANDROID_SERIAL" shell settings get secure navigation_mode
adb -s "$ANDROID_SERIAL" shell settings get secure back_gesture_inset_scale_left
adb -s "$ANDROID_SERIAL" shell settings get secure back_gesture_inset_scale_right
```

Then run the exact method-scoped `NexusControlGestureTest` command recorded by
the controller after applying the row's orientation, navigation, and
sensitivity settings. For C01-C04, copy the complete
`NEXUS_CONTROL_GESTURE_DIAGNOSTICS:` line from the passing result. For C05-C08,
the method must stop on its expected fully-gestural-navigation assertion; copy
the complete diagnostic prefix from that assertion and record no typed pass.
Any earlier failure, missing field, or diagnostic that does not match the raw
settings reads makes the row `Fail`, not `Pass`.

| Config | Orientation | Navigation mode | Sensitivity setting | Raw navigation readback | Raw sensitivity readback | WebView version | `systemGestures` R/B px | `mandatorySystemGestures` R/B px | CSS safe-area R/B px | Nexus target screen rect | Target overlap with R/B gesture bands | Diagnostic outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | Portrait | Gesture | Default | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C02 | Portrait | Gesture | Maximum | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C03 | Landscape | Gesture | Default | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C04 | Landscape | Gesture | Maximum | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C05 | Portrait | Three-button | Default | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C06 | Portrait | Three-button | Maximum | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C07 | Landscape | Three-button | Default | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| C08 | Landscape | Three-button | Maximum | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

## Core direction and edge-origin matrix

For every row, start within the named third of the 48px button. `Outer` is the
screen-edge third and `Inner` is the inward third. Swipe left for `Next` and
right for `Previous`. Expected: the WebView receives the complete stream;
exactly one adjacent visible pane activates in the named direction; Nexus stays
closed; and System Back/Home/quick-switch does not fire.
First establish enough visible panes that both directions have a non-boundary
target.

| Row | Config | Origin third | Direction | WebView pointer delivery | Observed pane / Nexus / system outcome | Human result |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | C01 | Outer | Next | Pending | Pending | Pending |
| M02 | C01 | Inner | Next | Pending | Pending | Pending |
| M03 | C01 | Outer | Previous | Pending | Pending | Pending |
| M04 | C01 | Inner | Previous | Pending | Pending | Pending |
| M05 | C02 | Outer | Next | Pending | Pending | Pending |
| M06 | C02 | Inner | Next | Pending | Pending | Pending |
| M07 | C02 | Outer | Previous | Pending | Pending | Pending |
| M08 | C02 | Inner | Previous | Pending | Pending | Pending |
| M09 | C03 | Outer | Next | Pending | Pending | Pending |
| M10 | C03 | Inner | Next | Pending | Pending | Pending |
| M11 | C03 | Outer | Previous | Pending | Pending | Pending |
| M12 | C03 | Inner | Previous | Pending | Pending | Pending |
| M13 | C04 | Outer | Next | Pending | Pending | Pending |
| M14 | C04 | Inner | Next | Pending | Pending | Pending |
| M15 | C04 | Outer | Previous | Pending | Pending | Pending |
| M16 | C04 | Inner | Previous | Pending | Pending | Pending |
| M17 | C05 | Outer | Next | Pending | Pending | Pending |
| M18 | C05 | Inner | Next | Pending | Pending | Pending |
| M19 | C05 | Outer | Previous | Pending | Pending | Pending |
| M20 | C05 | Inner | Previous | Pending | Pending | Pending |
| M21 | C06 | Outer | Next | Pending | Pending | Pending |
| M22 | C06 | Inner | Next | Pending | Pending | Pending |
| M23 | C06 | Outer | Previous | Pending | Pending | Pending |
| M24 | C06 | Inner | Previous | Pending | Pending | Pending |
| M25 | C07 | Outer | Next | Pending | Pending | Pending |
| M26 | C07 | Inner | Next | Pending | Pending | Pending |
| M27 | C07 | Outer | Previous | Pending | Pending | Pending |
| M28 | C07 | Inner | Previous | Pending | Pending | Pending |
| M29 | C08 | Outer | Next | Pending | Pending | Pending |
| M30 | C08 | Inner | Next | Pending | Pending | Pending |
| M31 | C08 | Outer | Previous | Pending | Pending | Pending |
| M32 | C08 | Inner | Previous | Pending | Pending | Pending |

## Ambient and ambiguity matrix

Use the applicable diagnostic config above and record any additional target
rect/inset change in Observed diagnostics. Rows A01–A15 supplement rather than
replace the 32 core rows.

| Row | Required dimension / action | Expected outcome | Config and observed diagnostics | Observed outcome | Human result |
| --- | --- | --- | --- | --- | --- |
| A01 | Nexus control visible and Nexus task closed; native tap | Nexus Root opens once; pane does not switch | Pending | Pending | Pending |
| A02 | Nexus control visible and Nexus task closed; keyboard or TalkBack activation | Native button path opens Root; pane does not switch | Pending | Pending | Pending |
| A03 | Nexus retreated; contact at former target geometry | No Nexus or adjacent command; normal system/page ownership | Pending | Pending | Pending |
| A04 | Player absent; qualifying swipe | Adjacent pane once; Nexus closed; no system gesture | Pending | Pending | Pending |
| A05 | Player present; qualifying swipe | Adjacent pane once at raised target; Nexus closed; no system gesture | Pending | Pending | Pending |
| A06 | IME open; qualifying swipe | Adjacent pane once; Nexus closed; no keyboard/system ambiguity | Pending | Pending | Pending |
| A07 | Reduced motion; qualifying swipe | Same semantic commit with no added motion requirement | Pending | Pending | Pending |
| A08 | TalkBack; tap-then-select through Nexus / Manage Tabs | Exact pane activates through the visible non-path alternative | Pending | Pending | Pending |
| A09 | Slow qualifying horizontal Next swipe | Next commits once; Nexus closed | Pending | Pending | Pending |
| A10 | Slow qualifying horizontal Previous swipe | Previous commits once; Nexus closed | Pending | Pending | Pending |
| A11 | Diagonal or vertical movement | No adjacent command and no Nexus open | Pending | Pending | Pending |
| A12 | Below-threshold horizontal reversal, then fresh tap | Swipe cancels; fresh tap opens Nexus; no stale suppression | Pending | Pending | Pending |
| A13 | Right-edge System Back gesture through/near target | System Back only; no pane switch or Nexus open | Pending | Pending | Pending |
| A14 | Bottom-edge System Home gesture through/near target | System Home only; no pane switch or Nexus open | Pending | Pending | Pending |
| A15 | Bottom-edge system quick-switch gesture through/near target | System quick-switch only; no pane switch or Nexus open | Pending | Pending | Pending |

## Operator conclusion

| Field | Recorded value |
| --- | --- |
| Overall physical USB gate | Pending |
| Failed or missing row ids | Pending |
| Reproduction notes | Pending |
| Screenshots/video/log references | Pending |
| Operator name and sign-off timestamp | Pending |

- [ ] All candidate, workflow, USB, device, and WebView metadata is complete.
- [ ] All eight configuration diagnostic rows contain measured inset and target
      geometry facts.
- [ ] All 32 core rows and all ambient rows are recorded `Pass` with observed
      outcomes.
- [ ] No ambiguity class occurred and no required direction was unreachable.

Until every box is checked from handset evidence, the physical USB gate remains
pending and this document asserts no pass.
