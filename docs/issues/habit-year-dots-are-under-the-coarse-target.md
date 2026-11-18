# individual habit dates have small touch targets

`apps/web/src/components/work/HabitYear.module.css` sets each date button to a
7px square with 2.5px gaps. touch can select a neighbouring date. the
`habit history` button opens the correction dialog at ordinary control size.

close when coarse-pointer users can pick an individual date at the normal
44px target through the year view or an explicitly equivalent interaction.
verify the requested date, including dates next to today and a month boundary.
