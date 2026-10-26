# native zoom captures can lag the rendered scale

problem: a screenshot can show normal-scale composition after real browser zoom
has updated layout. the cause is not established; capture/compositor
synchronization is suspected. dimensions alone do not prove faithful zoom pixels.

evidence: chromium 156 / playwright 1.64.1, source `47dbb98fc`, canonical lab
`20261025-160857-806c069b8e81`. at native 200%, all four captures reported css
1440×856, dpr 2 and protocol zoom 2, and produced 2880×1712 pngs. light/480 and
dark/320 visibly retained normal-scale composition; light/320 and dark/480
showed the expected doubled controls. native cdp capture used the measured
css-to-dip conversion. no application defect is established.

impact: native-zoom qualification needs pixel inspection as well as geometry.
reader controls were qualified using the two faithful captures and all four
geometry checks; the stale pair was excluded.

reproduce: open a reader with connections, set actual tab zoom to 200%, resize
the pane between 480/320px in both themes, then capture the native viewport.
resolve when capture waits for the compositor's current scale and every image
faithfully matches it after zoom or viewport changes.
