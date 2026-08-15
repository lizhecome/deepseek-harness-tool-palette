# DeepSeek Harness Tool Palette

Progressive tool discovery for DeepSeek Harness. The bundle keeps a compact per-Agent tool palette and exposes `tool_search`; a search can preview or unlock the best matching installed tools for later steps.

[中文说明](README.zh.md)

## Why

A large plugin and MCP installation can contribute many tool schemas to every model request. Tool Palette starts each Agent with `tool_search` plus a deployment-selected baseline, then reveals other global tools only when the model searches for their capability. The ToolRuntime remains the single source of truth, so model presentation, lookup, Code Mode bindings, and execution change together.

## Install

The repository is private, so clone it with an authenticated GitHub CLI session and install the checkout into a DSH profile:

```sh
gh repo clone lizhecome/deepseek-harness-tool-palette
cd deepseek-harness-tool-palette
dsh plugin --profile web add --ignore-workspace-root-check .
```

Replace `web` with `headless` or another profile name. The bundle is appended after the profile's existing bundles.

## Model-facing tool

`tool_search` accepts:

- `query` — a non-empty capability, operation, tool name, or parameter search.
- `unlock` — defaults to `true`; `false` returns matches without changing the palette.

An exact tool name ranks first, followed by name fragments, full-description matches, parameter text, and individual query tokens. Ranking is deterministic, and ties use the exact tool name.

Example requests:

```text
Find a tool that can write a file, then create notes.txt.
```

```text
Search the installed tools for subagent delegation without unlocking anything.
```

A successful unlocking search returns the matched names and makes them visible in the next model step. Calling `tool_search` again can reveal more capabilities; already visible matches remain enabled without registering duplicate restrictions.

## Default bundle configuration

The included `cordis.patch.yml` keeps these standard DSH tools visible before any search:

```yaml
alwaysVisible:
  - read
  - glob
  - grep
  - exit_plan_mode
  - todo_write
maxResults: 8
maxQueryChars: 400
descriptionMaxChars: 240
```

`tool_search` is always included and must not be repeated in `alwaysVisible`. Exact configured baseline names are validated when an Agent is adopted; a missing name fails loudly rather than silently weakening the configured palette.

For a minimal palette, override the bundle row in the profile patch:

```yaml
- id: tool-palette
  config:
    alwaysVisible: []
    maxResults: 6
    maxQueryChars: 300
    descriptionMaxChars: 180
```

## Scope and lifecycle

Each live Agent owns one reversible allow-list restriction. Two root Agents unlock independently. A child Agent has its own restriction; when it unlocks a hidden global tool, Tool Palette also admits that name through the intersecting runtime-owner ancestors required to make it reachable. A sibling retains its own restriction and does not gain the tool. Tools registered directly in an Agent's own scope remain visible because Harness deliberately merges scope-local tools after that scope's restrictions.

Tool Palette adopts Agents that already exist when the plugin loads and watches later `agent/created` events. Agent disposal removes its state. Plugin unload or hot reload lifts every restriction before unregistering `tool_search`, restoring the ordinary Harness tool surface.

Unlock state is intentionally process-local and advisory. It is not written into the Session log and resets after Agent or plugin reconstruction; each model request still records the tool set through Harness's normal reconstructable request path.

## Code Mode

In Code Mode, the reserved `run_code` transport remains visible because it is outside capability restrictions. The generated `tools` SDK initially declares `tool_search` and the configured baseline. After a nested `tool_search` call unlocks a capability, the next generated SDK includes that tool. Native function calling follows the same palette through ordinary schemas.

## Security and policy

Tool hiding is progressive disclosure, not an authority boundary. Unlocking a tool does not bypass `tools/pre-execute`, monotonic guards, approval, sandboxing, filesystem observation, deadlines, or the tool's own validation. A deployment must keep using those mechanisms for security decisions.

The plugin performs no network requests, reads no files, starts no subprocesses, and stores no credentials. Catalog searches inspect the ToolRuntime's detached global schemas only. Search output is bounded by `maxResults` and `descriptionMaxChars`.

## Model experience

Before a search, hidden global schemas do not enter the Agent's request, reducing the repeated tool-prefix cost. A search adds one retained tool call/result; unlocked schemas begin contributing tokens on the following step. Changing the visible schema set changes the model request prefix from that step, so provider KV-cache reuse can continue only through the preceding common prefix.

## Limitations

- Search covers global ToolRuntime schemas. Agent-local tools are already visible in their own scope and are not catalog results.
- Matching is deterministic lexical search, not embeddings or an LLM call.
- Unlocks last for the current live Agent lifecycle and are not a durable preference store.
- A child unlock must widen intersecting ancestor restrictions; that ancestor Agent can then see the tool, while separately restricted siblings cannot.
- Hiding a capability cannot secure it from trusted same-process code; policy belongs to guards, approvals, and capability providers.

## Development

Requires Node.js 24 and pnpm 10.15.0.

```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run
```

The unit suite uses published Harness services and covers native presentation, Code Mode SDK regeneration, deterministic search, bounds, late registration, root and sibling isolation, child ancestry, existing-Agent adoption, misconfiguration, and complete plugin disposal.

## License

MIT
