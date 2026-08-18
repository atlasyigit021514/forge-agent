# Context Virtual Memory (experimental)

## Hypothesis

Autonomous agents waste tokens because a large tool result is copied into every
following model request even when only a small region is relevant. Summarizing
the result is lossy; truncating it can remove the answer. Context Virtual Memory
(CVM) treats the model context like a CPU cache and the local process like exact
backing storage.

## Mechanism

1. A tool result above `optimization.contextVirtualMemory.minChars` is split on
   stable, mostly line-aligned boundaries and retained byte-for-byte in the
   session.
2. The model receives a deterministic map: page ids, character ranges, frequent
   terms, and a short sample. No second model call is used to create the map.
3. Only after pages exist, Forge injects the `context_recall` tool definition.
   The model can fetch an exact page or slice. Runs without large results pay no
   tool-schema tax.
4. Recalled text remains ordinary tool history, so the existing rolling window,
   deduplication, and compaction layers continue to work.

This is lossless within the lifetime of a session: concatenating every page
reconstructs the serialized tool result exactly. It is not claimed to be a new
scientific discovery; it is a falsifiable architecture experiment.

## Configuration

```json
{
  "optimization": {
    "contextVirtualMemory": {
      "enabled": true,
      "minChars": 6000,
      "pageChars": 2400,
      "previewChars": 320,
      "maxSessionChars": 2000000
    }
  }
}
```

## Evaluation plan

Run `node bench/paging.mjs`. The deterministic harness compares identical long
agent traces with CVM disabled and enabled, without API spend. Track input-token
reduction, peak context, recall count, task accuracy, and extra turns. Token
savings alone are insufficient: a useful result must preserve success rate and
avoid excessive recall calls on a corpus of real coding tasks.

The default two-million-character session cap is non-evicting: once full, new
large results fall back to Forge's normal elision path. Existing page ids never
silently change or point at evicted data.
