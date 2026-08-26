---
name: memory-system
description: Manage repository-scoped agent memory stored under the repository root's `/.memory` directory. Use this skill to sync session history, plans, and tickets into versioned session directories; load digests for fast recall; search, delete, and inspect memory; and get memory help.
---

# Memory System

Manage the repository-scoped agent memory stored under the repository root's `/.memory` directory. This skill keeps a durable record of what the agent has done on a repository so a later session can recall it quickly: raw conversation history, the working plan, and the concrete tickets derived from that plan.

## Memory model

Memory root:

```
<repo-root>/.memory
```

Session directory (`{session_dir}`):

```
<repo-root>/.memory/{version}/{date}/{sessionId}
```

Path segments:

- `{version}` — memory format version, e.g. the initial version is `v0.0.1`.
- `{date}` — the date the session was generated, in `YYYYMMDD` form, e.g. `20260825`.
- `{sessionId}` — the session id, chosen by the agent. It is stable for the lifetime of one session and is the key used to match an existing `{session_dir}` on a later `memory-sync`. **Naming rule (the agent MUST follow it):** a short kebab-case slug naming this session's task — lowercase letters, digits, and `-`; at least 3 characters with at least one letter; at most 64 characters. Derive it from the session's goal (e.g. `memory-system-skill-dev`, `fix-login-redirect`, `add-payments-api`). Never use a bare number (`1`), a UUID or hash, a timestamp, or a generic word like `session` / `test`.

Inside a `{session_dir}`:

- `digest.md` — a single file holding the memory summary. Written by the agent when it compacts (the compressed memory is synced into it), or produced by the `memory-digest` command, which actively summarizes the session content without compressing the current conversation.
- `session/` — a directory holding the session content. Its inner format is decided by the agent (no mandatory format such as `.json`). Its purpose is memory recall: it lets the agent quickly re-understand the whole repository implementation. Preserve the raw conversation content — in principle `digest`, `plan`, and `tickets` can be reconstructed from it — and refuse compression or any later non-agent modification.
- `plan/` — a directory that is the agent's single plan carrier. Its content is decided by the agent; keep one file per plan. Plans may be refined and updated over time.
- `tickets/` — a directory of actionable items decomposed from a plan. Each ticket records its implementation content, its landing status, and a progress description.

## Versioning

Two version numbers exist and must not be conflated:

- **Memory format version** (`{version}` in the path). Initial value `v0.0.1`. Per repository; it lives implicitly in the version directories under `/.memory`.
- **memory-system skill version**. Initial value `v0.0.1`; reported by `memory-help`.

The repository's current latest version is the lexically greatest `{version}` directory currently present under `/.memory`. When no version directory exists yet, treat the current version as `v0.0.1`.

Write versus read version semantics:

- **Write** (`memory-sync` and the automatic hooks): the session writes under the repository's current **latest** version by default. A session may pin a different write version with `memory-version` (e.g. `/memory-version v0.0.2`), after which every write of that session lands under the pinned version instead.
- **Read** (`memory-load`, `memory-search`, `memory-info`): default to a **global** search across every version under `/.memory`; a `{version}` parameter (e.g. `/memory-load version=v0.0.1`) narrows the search to that one version.

## Resolving the repository root

Every operation resolves paths against the repository root, then the memory root beneath it:

1. Walk upward from the current working directory until a `.git` directory is found; that directory is the repository root.
2. If no `.git` is found, use the current working directory as the repository root.
3. The memory root is always `<repo-root>/.memory`, and `{session_dir}` is always `<memory-root>/{version}/{date}/{sessionId}`.

## Operations

These are the eight operations this skill defines. Prefer the existing filesystem tools (`glob`, `read`, `grep`, `write`, `edit`, `pwsh`) to carry them out; the semantics below are the contract, not a fixed implementation.

### memory-sync

Persist the current session into a `{session_dir}`: its `session/` history, its `plan/` files, and its `tickets/` files.

Steps:

1. Resolve the repository root and memory root.
2. Determine `{version}` — the session's pinned write version when one was set with `memory-version`; otherwise the repository's current latest version (see *Versioning*).
3. Determine `{date}` — today's date as `YYYYMMDD`.
4. Match by `{sessionId}`: search the existing `{session_dir}` directories **under the write version** for one whose path ends in this `{sessionId}`. If found, reuse it; if not found, create a new `/.memory/{version}/{date}/{sessionId}` under the write version.
5. Write the raw conversation content into `session/` under the matched or new directory. Do not compress it.
6. Write or update one file per plan under `plan/`.
7. Write or update the ticket files under `tickets/`, each carrying implementation content, status, and progress.

Rules: `session/` is append-only after it is written — never compress or modify it later except by the agent acting in that same session. `plan/` and `tickets/` are the live, updatable state and may be refined on every sync.

### memory-load

Recall prior memory quickly for the agent.

Steps:

1. Resolve the memory root.
2. Enumerate `digest.md` files under `/.memory/{version}/{date}/{sessionId}/digest.md`. By default this is a **global** search across every version; a `{version}`, `{date}`, or `{sessionId}` parameter narrows it (e.g. `/memory-load version=v0.0.1` restricts the search to that one version).
3. Read the matching `digest.md` files and present their summaries. If a more specific recall is requested, fall back to reading the corresponding `session/`, `plan/`, or `tickets/` content.

Return the digest text (or the deeper content) so the agent can re-orient on the repository without replaying raw history.

### memory-delete

Remove memory by key. Destructive — confirm the matched scope before deleting.

Steps:

1. Resolve the memory root.
2. Match `{session_dir}` directories by exactly one of the three keys, supplied by the caller:
   - `{sessionId}` — delete the matching `{session_dir}` (every version/date combination carrying that id).
   - `{date}` — delete every `{session_dir}` under that `{date}`.
   - `{version}` — delete the entire `/.memory/{version}` subtree.
3. Delete only the matched directory or directories; never touch unmatched memory.

### memory-search

Find relevant memory by semantic query or by key.

Steps:

1. Resolve the memory root.
2. If the caller supplies `{sessionId}`, `{date}`, or `{version}`, match `{session_dir}` directories directly and return their `digest.md` paths plus `{session_dir}` paths. With no key, the search is **global** across every version.
3. If the caller supplies a semantic query, read the `digest.md` files (and, where the digest is insufficient, the corresponding `session/`, `plan/`, and `tickets/` content) and rank them by relevance to the query.
4. Return the matching `digest.md` content and the corresponding `{session_dir}` paths.

### memory-info

Extract memory content for one session.

Steps:

1. Resolve the memory root.
2. Locate the target by either the caller's `{sessionId}` (matched across versions/dates) or an explicit `{session_dir}` path.
3. Extract and return the requested part: the `session/` directory, the `plan/` directory, or the `tickets/` directory.

### memory-help

Show memory help.

Return:

- A brief description of each memory operation (`memory-sync`, `memory-load`, `memory-delete`, `memory-search`, `memory-info`, `memory-version`, `memory-help`, `memory-dsh-hook`).
- The repository's current latest version (see *Versioning*).
- The memory-system skill version (initial `v0.0.1`).

### memory-version

Pin the memory format version this session writes under (e.g. `/memory-version v0.0.2` switches the session from `/.memory/v0.0.1` to `/.memory/v0.0.2`).

Steps:

1. Resolve the memory root.
2. Validate the requested version against `v<major>.<minor>.<patch>` (e.g. `v0.0.2`); reject anything else with guidance.
3. Pin the version for the current session: subsequent `memory-sync` runs (and the automatic hooks) write under `/.memory/{pinned}/` — matching by `{sessionId}` **within that version** and creating `/.memory/{pinned}/{date}/{sessionId}` when absent.
4. Report the pinned version and the effective `{session_dir}`.

Rules:

- The pin is session-scoped: it affects only the session that sets it, until changed by another `memory-version`.
- With no pin, writes use the repository's current **latest** version (see *Versioning*).
- Read operations (`memory-load`, `memory-search`, `memory-info`) stay **global** across all versions by default regardless of the pin; only an explicit `{version}` parameter narrows them.
- Pinning does not move or copy existing memory — it changes where new writes land.

### memory-dsh-hook

Install the memory-system companion hook plugin into an agent preset so that every new session on that preset auto-mounts the hooks (plan-mode-end sync, compaction digest, repo-search memory injection, turn-close sync, dispose sync). Use this when a user wants the hooks in every session without per-session dynamic mounting — the one-time setup a new user runs.

Steps:

1. **Confirm the skill is collected** so the catalog advertises `memory-system` (typical: the user root `~/.dsh/skills/memory-system`, a git clone of the skill repository). The companion module ships with the repository at `plugin/memory-system-hooks.mjs`; copy it from the skill's resource base, or clone the memory-system repository if the collection lacks the file.
2. **Choose the preset base.** Copy `standard` (the full coding agent). Do NOT base it on `cordis`: its `tool-cordis` row publishes a process-global inspect provider, so a second cordis-based preset collides with a live cordis session (`Service already registered`).
3. **Create the user preset** through the `agentPresets` service — mount a temporary probe plugin (`inject: ['agentPresets']`, e.g. via the cordis dynamic-plugin tools) and call `copy(from, id, name)`; the id must match `[a-z0-9][a-z0-9-]*` (default `memory`, name `Memory System`). It copies the composition, metadata, skill directories, and assets into the user root.
4. **Write the plugin module** at `<preset>/plugin/memory-system-hooks.mjs` (the ESM module variant, `export default` + `ctx.tools.register` + `exec.agent`; relative row names resolve against the composition directory).
5. **Append the row** to the copy's `agent.cordis.yml`:
   ```yaml
   - id: memory-system-hooks
     name: './plugin/memory-system-hooks.mjs'
   ```
6. **Mount-validate**: call `standingKeyFor(id)`; it must return normally (a failure names the offending row — fix and retry).
7. **Hand off**: tell the user to start sessions on the new preset; the hooks then auto-mount in every session. The skill-catalog entry comes from step 1 and needs no preset work.

Fallback without probe tooling: perform steps 3–5 with plain filesystem tools (copy the preset directory, write the module and the row), then validate with `standingKeyFor` through a probe.

Operational note — updating the module later: row modules are cached per process (Node ESM) and a standing generation only recomposes when `agent.cordis.yml` changes, so editing `plugin/memory-system-hooks.mjs` alone is NOT picked up by a running process. After a module change, restart the process, or point the row at a new file name (e.g. `memory-system-hooks-v2.mjs`) so the next session imports a fresh module.

To uninstall, remove the `memory-system-hooks` row and the preset via `agentPresets.remove(id)` (or delete the preset directory).

## Hooks — mandatory automatic execution

The following executions are mandatory, not optional. When the companion hook plugin (`memory-system-hooks`) is mounted, it enforces them by listening to host events and landing files itself; when it is not mounted, the agent MUST perform them itself at the same trigger points.

| Trigger | Mandatory execution | Hook implementation |
| --- | --- | --- |
| Plan mode ends (`plan/mode` → `active: false`) | `memory-sync` the session into `{session_dir}`, capturing the approved plan into `plan/` | Host `session/event` listener (plugin lands `session/` and `plan/`; `tickets/` stays agent-synced per the skill) |
| Compaction completes (`compaction/summary`, `compaction/end`, checkpoint `user/message`) | Generate or update `digest.md` with the compressed memory, then `memory-sync` | Host `session/event` listener (writes `digest.md` from the `compaction/summary` blocks or the compact checkpoint `user/message` content, then syncs `session/`) |
| Repository search starts (tools `glob` / `grep` / `read` / `pwsh` on repo files) | `memory-load` the relevant digest and inject it so the search is informed by prior memory | Host `tools/post-execute` result enrichment |
| A turn closes (`agent/turn-stopping`) | Incremental `memory-sync` (session log append) | Host `agent/turn-stopping` listener |
| The agent / session is disposed (`agent/disposed`) | Final `memory-sync` | Host `agent/disposed` listener |

Notes:

- The hook plugin exports the raw session log as `{session_dir}/session/events.jsonl` — JSONL of `{seq, type, data}` session events, append-only — plus `session/README.md` describing the export. This is the plugin's `session/` content format; the agent may add its own files alongside it.
- On plan-mode end the plugin lands the approved plan under `{session_dir}/plan/`, one file per plan named by its first markdown heading (fallback `plan.md`), extracted from the `exit_plan_mode` tool-call arguments. On compaction it writes `{session_dir}/digest.md` from the `compaction/summary` blocks (or the compact checkpoint `user/message` content when no summary block exists), then syncs `session/`.
- When the hook plugin is mounted it also registers the `memory_sync_now` model tool, which forces a sync of the current session through the same code path as the hooks. Its `sessionId` is agent-specified, required, and must follow the naming rule in *Memory model* (a kebab-case task slug, e.g. `memory_sync_now(sessionId: 'memory-system-skill-dev')`); the tool REJECTS ids that violate the rule (bare numbers, UUIDs, generic words) and asks for a task slug. The id is remembered and reused by every hook, and sync matches existing `{session_dir}` directories by it. Before the agent specifies an id, hooks fall back to a sanitized session-title slug — never the internal session UUID.
- The plugin also registers `memory_version_now(version)` — the hook-side carrier of `memory-version`: it pins (or clears with an empty string) the memory format version the session writes under, and every hook then writes under `/.memory/{pinned}/` while reads stay global (see *memory-version*).
- The hooks land files directly with the filesystem service; they guarantee the trigger points but do not replace the agent-side operations in this document — when the plugin is absent, the agent performs those operations at the same triggers.
- To install the hook plugin so it auto-mounts in every session, run the `memory-dsh-hook` operation (see *Operations*); it copies a `standard`-based preset, wires `plugin/memory-system-hooks.mjs` into it, and mount-validates the result.

## Rules and invariants

- The memory root and all session directories live under `<repo-root>/.memory`; never scatter memory elsewhere.
- `session/` preserves the raw conversation and is not subject to compaction or non-agent edits; `digest.md`, `plan/`, and `tickets/` are the derived and updatable artifacts.
- `memory-sync` always matches on `{sessionId}` first, so a resumed session updates its own directory rather than forking a new one.
- Destructive `memory-delete` is scoped by exactly one key at a time and requires confirming the matched set before removal.
