# Token Kernel: a 90% reduction hypothesis

Token Kernel is an opt-in research mode, not a transparent compression switch.
It changes the agent protocol to remove repeated prompt material from the model's
working context.

## Architecture

- **Minimal policy transcript:** a short invariant kernel replaces the long
  personality/instruction prompt. Tool execution still uses Forge's local
  implementation, but arbitrary custom prompt rules are not automatically
  preserved.
- **Working set, not replay:** each call receives the original task, a bounded
  deterministic action ledger, and the latest complete assistant/tool exchange.
- **Demand-paged evidence:** older large evidence lives in Context Virtual
  Memory and can be recalled exactly.
- **Demand-loaded capabilities:** six coding tools are initially visible. The
  `load_tool_group` meta-tool exposes filesystem, shell, memory, skill, process,
  or graph capabilities only when needed.

This attacks all three recurring token sources: system prompt, history, and tool
schemas. It does not assume that a stateless Chat Completions endpoint remembers
an earlier request.

## Enable

Set `optimization.tokenKernel.enabled` to `true` in `.agent-data/config.json`.
Keep it off for tasks whose behavior depends on the full custom system prompt.

## Falsification criteria

Run `node bench/token-kernel.mjs` for payload cost. Then evaluate at least 100
real tasks, split by coding, shell, memory, and skill use. Reject the experiment
unless it achieves all of:

1. at least 90% median input-token reduction on runs of 10+ calls;
2. no more than 3 percentage points loss in verified task success;
3. no more than 15% additional model calls from page/group loading;
4. zero cases where a ledger preview is presented as stronger evidence than the
   hashed underlying tool result.

The deterministic benchmark proves only byte/token reduction. Scientific value
comes from the quality evaluation, especially adversarial tasks that require an
instruction or fact from much earlier context.
