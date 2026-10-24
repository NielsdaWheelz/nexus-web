# resource row root class overrides layout

ordinary `ResourceRow` spreads `rootProps` after its computed `className`
(`apps/web/src/components/ui/ResourceRow.tsx:105-113`). supplying a root
class therefore removes the row's grid, selection and geometry classes. the
outline branch merges classes correctly. no current ordinary caller supplies a
root class, so podcast artwork does not exercise this gap.

resolve by merging the caller class with the owned classes after spreading root
attributes. verify an ordinary row retains both its grid and caller class.
