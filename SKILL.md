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
- `{sessionId}` — the session id, chosen by the agent. It is stable for the lifetime of one session and is the key used to match an existing `{session_dir}` on a later `memory-sync`.

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

## Resolving the repository root

Every operation resolves paths against the repository root, then the memory root beneath it:

1. Walk upward from the current working directory until a `.git` directory is found; that directory is the repository root.
2. If no `.git` is found, use the current working directory as the repository root.
3. The memory root is always `<repo-root>/.memory`, and `{session_dir}` is always `<memory-root>/{version}/{date}/{sessionId}`.

## Operations

These are the six operations this skill defines. Prefer the existing filesystem tools (`glob`, `read`, `grep`, `write`, `edit`, `pwsh`) to carry them out; the semantics below are the contract, not a fixed implementation.

### memory-sync

Persist the current session into a `{session_dir}`: its `session/` history, its `plan/` files, and its `tickets/` files.

Steps:

1. Resolve the repository root and memory root.
2. Determine `{version}` — the repository's current latest version (see *Versioning*).
3. Determine `{date}` — today's date as `YYYYMMDD`.
4. Match by `{sessionId}`: search the existing `{session_dir}` directories for one whose path ends in this `{sessionId}`. If found, reuse it; if not found, create a new `/.memory/{version}/{date}/{sessionId}`.
5. Write the raw conversation content into `session/` under the matched or new directory. Do not compress it.
6. Write or update one file per plan under `plan/`.
7. Write or update the ticket files under `tickets/`, each carrying implementation content, status, and progress.

Rules: `session/` is append-only after it is written — never compress or modify it later except by the agent acting in that same session. `plan/` and `tickets/` are the live, updatable state and may be refined on every sync.

### memory-load

Recall prior memory quickly for the agent.

Steps:

1. Resolve the memory root.
2. Enumerate `digest.md` files under `/.memory/{version}/{date}/{sessionId}/digest.md` (optionally filtered by `{version}`, `{date}`, or `{sessionId}`).
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
2. If the caller supplies `{sessionId}`, `{date}`, or `{version}`, match `{session_dir}` directories directly and return their `digest.md` paths plus `{session_dir}` paths.
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

- A brief description of each memory operation (`memory-sync`, `memory-load`, `memory-delete`, `memory-search`, `memory-info`, `memory-help`).
- The repository's current latest version (see *Versioning*).
- The memory-system skill version (initial `v0.0.1`).

## Rules and invariants

- The memory root and all session directories live under `<repo-root>/.memory`; never scatter memory elsewhere.
- `session/` preserves the raw conversation and is not subject to compaction or non-agent edits; `digest.md`, `plan/`, and `tickets/` are the derived and updatable artifacts.
- `memory-sync` always matches on `{sessionId}` first, so a resumed session updates its own directory rather than forking a new one.
- Destructive `memory-delete` is scoped by exactly one key at a time and requires confirming the matched set before removal.
