# companion resource rows stay 15

status: open; follow-up to companion density, which set companion content type and left them out.

`ResourceRow`s inside a companion, such as chat rows and find results, keep a 15px title and 13px
metadata beside connections rows at 13 and 12 (`apps/web/src/components/ui/ResourceRow.module.css:7,63,98`).

a token there isn't free. `.row` owns the `indexRow` container, and its `@container` thresholds
read that font size, so a row between about 416px and 480px changes layout: at 440px, trailing
controls hidden at 15px show at 13px (`ResourceRow.module.css:137,145,176,263`). `.compact` shares
`.row`, so moving its font rules onto tokens would flip the queue too.

resolved when companion resource rows take companion type, with a case over the threshold band,
or the owner rules that they stay.
