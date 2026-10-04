# field controls repeat appearance rules

status: open. origin: 2026-10-04 source audit; area: ui field controls. priority: p3.

`apps/web/src/components/ui/Input.module.css:1-59`, `Textarea.module.css:1-67` and `Select.module.css:8-34` repeat their default color, background, border, radius, focus ring and disabled rules. input and textarea also repeat bare and placeholder rules. their layout, select chevron, textarea growth and caller overrides differ. no rendered regression is observed.

prerequisite: inspect current component class order and auth password/chat composer overrides. acceptance: if one shared css-module appearance class preserves specificity and load order, keep only layout rules in the existing modules. compare computed normal/focus/disabled styles and a narrow screenshot on an existing surface, including auth password padding, chat placeholder, textarea growth and select chevron. reject the cut if preserving the cascade requires more machinery than it removes.
