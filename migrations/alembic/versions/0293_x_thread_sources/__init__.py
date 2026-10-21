"""Migration 0293's private, frozen copy of the application code it runs.

0293 converts published X captures with the rendering, preparation and write logic of
d6f04890c (deployed 2026-10-19, head 0297), the release that ran it. A migration that
imports live application code replays against whatever schema that code assumes
today; this package never imports ``nexus``, so 0293 replays at the 0293 schema.

Pure modules are d6f04890c's own, keeping only the definitions 0293 reaches; their
first line names the source file. ``writes`` holds the SQL equivalents of the
service calls 0293 makes, at the 0293 schema. Only 0293 loads this package.
"""
