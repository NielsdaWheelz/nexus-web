# native marker qualification

resource type marker checks use the disposable lab's headless browser. native
browser zoom, physical touch interaction and operating-system clipboard behavior
remain unobserved; root font scaling, protocol input and browser-local selection
or serializer checks prove only their respective browser contracts.

impact: the implementation cannot claim native touch, native 200% zoom or system
clipboard qualification from these checks alone. ordinary headless verification
has no desktop or clipboard authority (`docs/local-rules/testing-standards.md`).

resolution: with explicit authority for each native observation, inspect nested
outline/index rows at 200% browser zoom; open and dismiss a relationship menu by
physical touch; copy outline prose and an index title to a private clipboard
consumer. confirm geometry, focus restoration and unchanged copied content. no
production account or personal browser is needed.
