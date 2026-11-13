# native touch can miss the coarse-pointer minimum

the owned api-34 webview 113 reports `any-pointer: coarse = false`,
`any-pointer: fine = true`, `hover: none = true`, and `maxTouchPoints = 5`, even
after a real adb touch. composer qualification run
`20261112-232928-6129223dd77e` retains those facts in its private
`composer-android.json`; both composer controls measured 32px before the repair.

`components/ui/Control.module.css` defaults compact controls to `--size-md`
(32px) and raises them to `--size-xl` (44px) only for `any-pointer: coarse`.
the composer now owns its phone minimum through `--control-min-size`; other
phone controls that depend only on this media query remain unaudited.

impact: native touch does not establish the coarse-pointer css branch in this
environment. do not infer other phone target sizes from chromium emulation.

resolved when the shared phone-target contract is explicit and representative
native controls outside the composer meet it under these observed input facts.
