# quote link extends beneath the row actions

companion density gives `ResourceOutline.module.css` `.content` a floated hole
and absolutely positions `.actions`. the block `.primaryLink` still spans the
whole content box, so its focus ring and blank clickable area extend beneath
the `⋯` column even though its first text line wraps clear of the control.

impact: the visual link boundary includes the command column; blank space near
the menu can navigate. inspect a focused quote and click beside its menu.

resolved when: quote focus and hit geometry exclude the command column while
later lines retain the 309px measure and every quote word remains present.
