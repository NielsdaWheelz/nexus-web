# library picker intercepts modified text editing keys

status: open · origin: 2026-10-14 library picker design audit · area: web / library keyboard interaction

problem: list navigation handles modified editing keys inside the text input.

evidence: `apps/web/src/components/libraries/LibraryChooser.tsx:156-188` handles arrows, home, end and enter without checking shift/control/alt/meta. shift+home/end is prevented and moves the active row instead of selecting input text. the composition ref protects ordinary composition; native composition signal and platform behavior need verification. source trace only.

prerequisites: assign text editing to the browser and option navigation to the shared chooser.

fix: handle only the explicitly supported unmodified picker keys; preserve browser selection/cursor shortcuts and composition. keep escape under the existing overlay owner. unmodified home/end should edit the input under the proposed repeated-entry contract.

acceptance: shift+home/end and native word/cursor commands edit/select text; unmodified up/down navigate; composing enter commits text without activating a destination; escape still dismisses the innermost surface.
