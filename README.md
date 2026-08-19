# Forge Agent

[![CI](https://github.com/atlasyigit021514/forge-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/atlasyigit021514/forge-agent/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-b8f35c.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-5FA04E.svg)](https://nodejs.org/)

> A local-first autonomous agent with a web GUI, persistent tools, and an experimental Token Kernel for aggressively bounded model context.

Forge is a local coding and computer-command agent inspired by terminal-first tools such as Claude Code. It provides an editable system prompt, persistent memory, installable `SKILL.md` capability packs, and a provider-neutral connection for OpenAI-compatible APIs.

⭐ If Forge helps your workflow, star the repository—it helps others discover the project.

## Features

- Iterative agent loop with standard OpenAI-compatible function calling
- Background autonomous runs that continue independently of the browser request
- Live Server-Sent Events for status, model turns, retries, tool calls, and results
- Reconnectable progress display that recovers missed events after a refresh or connection loss
- File listing, reading, exact patching, writing, and workspace search
- PowerShell command execution with timeouts and captured output
- Persistent interactive PowerShell sessions with incremental reads, writable stdin, prompt detection, and one-call run/wait tools
- Resumable user-input handoffs: an autonomous task automatically pauses when a running command requests an OTP, code, password, or other input, then continues the same task and shell PID
- Native Windows computer control: launch/focus apps, inspect UI Automation controls, capture screenshots, click, type, send shortcuts, and scroll
- Strict foreground and background desktop modes, including off-screen/occluded window OCR, single-use observation IDs, and verified actions that never steal focus in background mode
- A pre-warmed persistent computer-control worker plus one-call web/YouTube/app navigation for low-latency simple tasks
- Background-safe Roblox `.rbxlx` place and Lua script creation without opening Roblox Studio
- Persistent local memories with review and deletion controls
- Local skill creation and HTTPS `SKILL.md` downloading
- File metadata, directory creation, copy, move, deletion, and process inspection tools
- Fully editable system prompt, model, endpoint, temperature, and turn limit
- Configurable transient-request retries with exponential backoff and `Retry-After` support
- API keys kept in `.agent-data/config.json`, which is excluded from Git

## Start

Requires Node.js 20 or newer. No package installation is needed.

```powershell
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317), select **Settings**, and enter:

- **Provider name:** any label you want to display in the UI
- **Base endpoint:** the provider's OpenAI-compatible API root, normally ending in `/v1`
- **API key:** the key supplied by your provider
- **Model:** the exact model identifier exposed by that endpoint

The runtime calls `POST {baseEndpoint}/chat/completions`. Extra provider headers can be added directly to `.agent-data/config.json` under `provider.headers` if the service requires them.

Forge is designed for providers that implement OpenAI-compatible streaming chat completions and tool calling. DeepInfra and ModelFlare have both been tested successfully. Other compatible providers should work without code changes, although provider-specific differences in streaming or tool-call behavior may require configuration.

The default model identifier is `deepseek-ai/DeepSeek-V4-Flash-0731`. Change it in Settings or through `FORGE_MODEL` when your provider exposes a different identifier.

Failed requests are retried for network errors, HTTP 408/409/425/429, and HTTP 5xx responses. Retry attempts and the initial backoff delay are configurable in Settings; permanent 4xx errors fail immediately.

## Autonomous runs and live progress

Starting a task returns immediately while the server continues the agent loop in the background. The Agent screen opens an SSE connection and displays each model turn, retry, tool request, tool result, and completion status as it happens. If the page refreshes or the stream disconnects, the browser reconnects to the active session and retrieves missed events.

The default autonomous limit is 1000 model turns. It is not a time limit: a run normally ends earlier when the model returns a final answer without additional tool calls. Use **Stop run** to request cancellation after the current provider call or tool operation finishes.

Environment variables can provide initial values:

```powershell
$env:FORGE_API_KEY="..."
$env:FORGE_API_BASE_URL="https://your-endpoint/v1"
$env:FORGE_MODEL="deepseek-ai/DeepSeek-V4-Flash-0731"
npm start
```

## Interactive terminal

The Terminal screen and the agent's `shell_*` tools use persistent PowerShell processes. Variables, working-directory changes, activated environments, REPL state, and prompt/response programs persist for the life of the shell. Output is read incrementally and input can be sent at any time.

The implementation provides interactive stdin/stdout pipes, not a Windows ConPTY terminal. Line-oriented prompts and REPLs work; full-screen cursor-controlled applications such as Vim, `top`-style dashboards, and some password interfaces require a future ConPTY integration.

`shell_run` starts a command and waits for exit, useful output, or an input prompt. `shell_wait` continues watching the same process. When a running command needs information only you can provide, Forge detects common emitted prompts plus PowerShell `Read-Host` and POSIX `read -p`, changes the Agent screen to a waiting state, and accepts your next message as the answer instead of starting a new task. The answer is written into that exact PID; Forge captures the resulting output and resumes the same autonomous task. The explicit `request_user_input` tool remains available for prompts that cannot be inferred from shell output.

## Windows computer use

Forge includes native Windows desktop tools with no browser extension or per-app integration required. It can launch executables and URI handlers, select exactly one visible window, inspect named UI controls, capture an occluded window, click, type, send shortcuts, and scroll. The built-in Windows OCR engine supplies text and coordinates when Electron, game, Qt, or canvas interfaces expose little accessibility data.

For known labels, `computer_find_and_act` performs selection, observation, fuzzy text matching, one action, and post-action verification in a single call. For exploratory work, `computer_observe` returns a time-limited `observationId`; `computer_interact` consumes that exact observation once and returns a refreshed observation. This prevents stale indexes from being reused after the UI changes. Repeating the same failed action twice or the same unchanged observation three times is blocked by the executor rather than left to the model.

Simple navigation requests use `computer_navigate`: opening an app, URL, web search, YouTube search, or resolving and playing a matching YouTube video is one tool call rather than a window-list/screenshot/OCR loop. Token Kernel preloads the computer group when the task mentions a desktop app and hides unrelated tool-group loading on simple desktop tasks without reducing the configured autonomous turn budget. Simple desktop tasks also disable provider reasoning effort for lower latency. The relevant `fast-computer-use` skill is loaded automatically.

Background is the enforced default for the entire task. Foreground is selected only from explicit wording such as “foreground”, “ön plan”, “önüme getir”, or “show me”. The agent executor overwrites conflicting model tool arguments, and `computer_focus` is rejected unless foreground was requested. Background actions never fall back to foreground. Delivery is not treated as success: Forge hashes the captured window before and after the action and returns `background_input_rejected` when an app, such as a GPU/Qt surface, ignores synthetic background input.

For Roblox work, `roblox_project` bypasses fragile GUI input. Its `build_place` action creates a valid XML `.rbxlx` baseplate place, adds every requested server, client, or module script to the correct service, and inspects the result in one background call. Opening the finished place in Studio requires an explicit foreground request; background mode leaves the ready project on disk and does not expose Studio.

Observation uses a depth- and time-bounded UI Automation walker rather than an unbounded descendant query. Roblox Studio, Roblox Player, Discord, Chrome, and Edge route directly to background OCR because their accessibility trees are commonly sparse or slow. Any observation timeout terminates the stuck worker so the following call starts cleanly; it cannot poison the rest of the agent run.

## Skills

A skill is stored at `.agent-data/skills/<name>/SKILL.md`. Install one from the Skills screen using a direct HTTPS URL, or ask the agent to create one. Installed skill descriptions are included in the system context; the agent reads the complete skill only when relevant.

## Data layout

```text
.agent-data/
  config.json
  memory.json
  skills/
    example/
      SKILL.md
```

All runtime data remains local and is ignored by Git.

## Token efficiency

Forge keeps the context sent to the model bounded:

- **Rolling window** (`context.maxRecentMessages`, default 24): only the most recent messages are sent each call, cut at safe turn boundaries. The original task statement is preserved. The full working history stays in the session for UI replay and compaction decisions.
- **Auto-compaction** (`compaction.*`): when the working history crosses `thresholdTokens` (default 32,000), the oldest complete turns are summarized into a single cumulative `[COMPACTED CONTEXT]` system message (capped at `maxSummaryTokens`). The original system prompt is preserved; repeated compactions fold into one block.
- **Tool result elision** (`context.maxToolResultChars`, default 8,000): oversized tool output (reads, shell output, searches) is truncated head-and-tail with a marker before entering history.
- **Relevant memory only**: memories are scored (term match + recency), injected into the **first model call only**, capped at `context.memoryTopK` items with per-item length limits. Trivial queries retrieve nothing.
- **Duplicate detection**: a trailing history message identical to the new request is not re-sent; the autonomy boilerplate is only appended if the system prompt lacks it.
- **Telemetry**: each session reports `stats` (calls, input/output/cached tokens, tool calls, retries, latency) via `sessionView` and a `stats` SSE event. The bench harness (`bench/harness.mjs`) reproduces runs deterministically without API spend.
- **Graphify integration**: one `graphify` tool can build and query a persistent AST-backed code graph instead of repeatedly reading source files. Install the external CLI with `uv tool install graphifyy`; disable it with `optimization.graphify.enabled: false` if it is not wanted.
- **Lossless result deduplication**: repeated large tool results are stored once per session and subsequent copies become content-hash references. This never rewrites system, user, or assistant messages.
- **Experimental Context Virtual Memory**: large tool results are kept losslessly in session-local pages while the model receives a compact lexical page map. An exact `context_recall` tool is injected only when pages exist, avoiding its schema cost on ordinary runs. See `docs/context-virtual-memory.md` and run `node bench/paging.mjs` for the deterministic A/B harness.
- **Experimental Token Kernel**: an opt-in bounded working-set protocol replaces repeated long prompts/history/tool schemas with a small kernel, deterministic action ledger, demand-paged evidence, and demand-loaded tool groups. It deliberately trades full custom-prompt fidelity for an aggressive token target. See `docs/token-kernel.md` and run `node bench/token-kernel.mjs`.
- **Optional semantic tool compression**: an LLMLingua/Headroom-style sidecar can compress oversized tool output through `optimization.semanticToolCompression`. It is disabled by default, fail-open, protected by an inflation guard, and never receives prompts or instruction messages. The endpoint contract is `POST { text, targetRatio }` returning `{ compressedText }`.

The optimization layer does not modify the configured system prompt or any installed skill/instruction content. A Headroom or other OpenAI-compatible optimizing gateway can also be used directly as Forge's existing provider base URL without code changes.

## Verify

```powershell
npm test
```

For a live model smoke test, use **Test connection** in Settings. This deliberately requires your real endpoint and key and is not run by the automated suite.

## Security

Secrets and runtime state belong in `.agent-data/` or environment variables; both `.agent-data/` and `.env` are excluded from Git. Never commit a real provider key. See [SECURITY.md](SECURITY.md) for reporting security issues.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## License

MIT © Forge Agent contributors.
