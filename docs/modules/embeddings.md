# Embeddings

`services/semantic_chunks.py` owns the existing OpenAI embedding adapter, model
identity, dimensions and vector validation. `services/content_indexing.py` owns
source chunk ranges. Both use the same configured model.

The operator setting accepts `text-embedding-3-small` or `text-embedding-3-large`;
the default remains small with 256 dimensions. Arbitrary names are refused by
settings validation. The adapter always supplies dimensions, which the
[provider API](https://developers.openai.com/api/reference/python/resources/embeddings/methods/create)
supports for the third-generation models. That contract limits each input to
8,192 tokens and each request to 300,000 tokens.

Both configured models use `cl100k_base`, as attested by OpenAI's
[model mapping](https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py#L42).
The corresponding [ordinary encoder and byte-pair merge](https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/src/lib.rs#L334)
partition UTF-8 bytes into nonempty pieces and only merge their initial byte
symbols. They do not insert tokens. Therefore input tokens cannot outnumber
input UTF-8 bytes. This conservative bound needs no runtime tokenizer or
source-sized list of token integers.

Document indexing retains the existing 420-word windows and 60-word overlap
where their bytes fit. Larger windows are partitioned at exact codepoint
boundaries into at most 8,191 UTF-8 bytes, also enforced when adjacent block
parts coalesce. Adjacent blocks with the same fragment or page anchor may include
only their original whitespace tail and prefix, charged to that byte envelope.
Unknown source gaps still require separate chunks; no separator is invented.
Original blocks remain complete; whitespace-only slices retain
the existing no-embedding disposition. Every emitted locator and quote names
its exact source slice. Retrieval chunks do not claim to preserve independent
grapheme rendering. The stored spool's separate structural envelope is unchanged.

The adapter preserves input order and takes at most 64 inputs and 300,000
summed UTF-8 bytes per request. Ordinary batches still use one call. An
indivisible large query still reaches the existing provider-owned context
rejection and lexical fallback; a local conservative count is never represented
as a provider verdict.

The price is more chunks and possibly more provider requests for long words or
large Unicode windows. No supported source is shortened to meet an embedding
input bound. Provider billing, full-source indexing cost and worker overlap
still require their existing qualification. The external HTTP proof enforces
this byte envelope, not the provider's exact tokenization of each test string.
