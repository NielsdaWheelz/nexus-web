# youtube upload channels are published as authors

problem: youtube ingestion treats the upload channel as the video's author,
although a channel identity does not establish authorship.

evidence: `python/nexus/services/youtube.py:68-80` publishes
`snippet["channel_title"]` in the `author` role with a `youtube_channel` key;
`:94-95` labels the observation `youtube_metadata`.
`python/nexus/services/contributor_taxonomy.py:27` already defines `channel`.
the research contract at `python/nexus/services/metadata_enrichment.py:78-85`
requires established, distinct roles. source review only; no live sample checked.

impact: reuploaders, archives and institutions can become author bylines and
author-filter matches without authorship evidence. a later source observation
can replace a researched author slice with the channel.

resolve at the youtube adapter: publish the observed channel role; establish
authors separately from evidence. correcting retained credits needs a bounded,
source-proved repair, not a blanket role rewrite or person merge.

resolved when a channel-only snippet produces a channel credit without an
invented author, a known reupload retains separately established authorship,
and existing affected credits have an explicit repair disposition.
