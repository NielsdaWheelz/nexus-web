# disabled nexus activation includes its usable overflow

problem: a nexus passage with unavailable title navigation can have valid resource
commands, but its overflow inherits an aria-disabled grid-cell ancestor. normal
pointer activation opens the menu; accessibility/actionability reports it disabled.

evidence: baseline `daf605a8d`, `apps/web/src/components/nexus/desktop/DesktopNexus.tsx:310`
sets the candidate cell's aria-disabled from row.action. a real note-owned chunk
lookup during overflow qualification produced an enabled overflow button within
that disabled ancestry; native pointer activation sent its note-actions request
and displayed edit/delete. playwright's normal locator click refused it as disabled.

fix at the launcher row owner: scope unavailable-navigation semantics to the
primary action, keeping independent resource commands correctly represented.
prove keyboard and assistive access to that menu with unavailable title navigation,
while the primary action remains unavailable. this pre-existing row accessibility
gap is outside the menu-caption change; physical/spoken checks remain unrun.
