# deliberate selection records its timestamp beyond the palette sketch

problem: the palette sketch defines `select(list, key)`, while
`lib/nexus/list.ts:71` takes `now` and records `armedAt`. the controller supplies
`performance.now()` and the temporary pure cases follow this signature.

impact: api documentation differs; deliberate firing remains immediate and clears
`previous`, so the timestamp does not impose latency. this is not a runtime defect.

resolved when the lasting module contract and owner review accept the explicit
timestamp, or the signature is simplified without changing deliberate firing.
