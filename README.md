# memory-system

A DeepSeek Harness (dsh) **skill** that manages repository-scoped agent memory.

The skill persists what the agent has done on a repository into `<repo-root>/.memory`, so a later session can recall it quickly: raw session history (`session/`), the working plan (`plan/`), the concrete tickets derived from the plan (`tickets/`), and the memory summary (`digest.md`). Six operations are defined: `memory-sync`, `memory-load`, `memory-delete`, `memory-search`, `memory-info`, `memory-help`.

## What is in this repository

```
memory-system/
├── SKILL.md       # the skill itself — this file at the repository root is what dsh collects
├── README.md      # this file
└── .gitignore     # ignores runtime memory data (/.memory)
```

This repository **is itself a standard dsh skill root**: the skill lives directly at the repository root as `SKILL.md`, matching the one-level discovery format of the dsh `skill-filesystem` provider (`<root>/<name>/SKILL.md` or `<root>/<name>.md`). That means dsh can collect it with no repository-specific tooling.

## How dsh collects this skill

dsh discovers skills by scanning local skill roots. Collect this repository using any of the following standard methods.

### 1. User root — recommended, available to every project

Clone (or copy) the repository as `memory-system` under the dsh home skills directory:

```powershell
git clone git@github.com:ELEboysss/memory-system.git $env:USERPROFILE\.dsh\skills\memory-system
```

After this, `~/.dsh/skills/memory-system/SKILL.md` exists, and every dsh agent session on this machine sees the `memory-system` skill (user root, rank 400).

### 2. Project root — scoped to a single repository

```powershell
git clone git@github.com:ELEboysss/memory-system.git <repo>\.dsh\skills\memory-system
```

The skill is then auto-discovered whenever an agent works inside `<repo>` (project root, rank 100).

### 3. Custom skill directory

Point the `customSkillDirs` option of the `skill-filesystem` row at this repository's root. The root is scanned as a flat skill root (rank 300).

Once collected, `memory-system` appears in the dsh session's skill catalog and is loadable through the `skill` tool.

## Memory layout

```
<repo-root>/.memory/
└── {version}/            # memory format version, e.g. v0.0.1
    └── {date}/           # session date, YYYYMMDD, e.g. 20260825
        └── {sessionId}/  # session id, chosen by the agent
            ├── digest.md # memory summary (compaction / memory-digest)
            ├── session/  # raw session content (read-only after write)
            ├── plan/     # one file per plan (updatable)
            └── tickets/  # actionable items decomposed from the plan (updatable)
```

## Mandatory hooks — companion plugin

The skill's contract (see `SKILL.md` → *Hooks — mandatory automatic execution*) requires automatic executions at five trigger points. A skill alone is instructions only; the **companion hook plugin** (`plugin/memory-system-hooks.js`, host half of a Cordis plugin) enforces them by listening to host events:

| Trigger | Mandatory execution | Host event |
| --- | --- | --- |
| Plan mode ends (`plan/mode` → `active: false`) | `memory-sync` | `session/event` |
| Compaction completes | write `digest.md`, then `memory-sync` | `session/event` (`compaction/end`, checkpoint `user/message`) |
| Repository search (`glob`/`grep`/`read`/`pwsh`) | inject relevant digest into the result | `tools/post-execute` |
| A turn closes | incremental `memory-sync` | `agent/turn-stopping` |
| Agent / session disposed | final `memory-sync` | `agent/disposed` |

It also registers the `memory_sync_now(sessionId)` model tool — `sessionId` is agent-specified and required per the skill (e.g. `memory_sync_now(sessionId: 'my-session')`), remembered and reused by every hook; before the agent specifies one, hooks fall back to a sanitized session-title slug. Writes carry the session's resolved sandbox policy, so under the default `workspace-write` mode it persists `<session-cwd>/.memory/…` within the same confinement as the agent's own tools.

Install (one-time, per session): paste the `return { … }` expression into `cordis_define` (`code.host`) and `cordis_run`; for persistence, mount the same code as a preset plugin row.

### Auto-mounting in every session

The skill itself is already collected at the dsh user root (`~/.dsh/skills/memory-system`), so every session's skill catalog advertises it. To auto-mount the hook plugin in every session, **run the skill's `memory-dsh-hook` operation** — the documented one-time setup any new user (or any agent with this skill loaded) can follow. It performs the steps below automatically:

1. Copy a shipped preset into the user root (`agentPresets.copy`), e.g. `standard` → id `memory`:
   `copy(from: 'standard', id: 'memory', name: 'Memory System')`.
2. Place `plugin/memory-system-hooks.mjs` (the ESM module variant) at `<preset>/plugin/memory-system-hooks.mjs`.
3. Append a row to the copy's `agent.cordis.yml`:
   ```yaml
   - id: memory-system-hooks
     name: './plugin/memory-system-hooks.mjs'
   ```
4. Mount-validate with `standingKeyFor('memory')`, then start sessions on that preset in the UI.

> **Updating the plugin later:** row modules are cached per process and a standing generation only recomposes when `agent.cordis.yml` changes. After editing `plugin/memory-system-hooks.mjs`, restart the process — or point the row at a new file name (e.g. `memory-system-hooks-v2.mjs`) so the next session imports the fresh module.

Do not base the preset on a copy of `cordis`: its `tool-cordis` row registers a process-global inspect provider, so a second cordis-based preset collides with a live cordis session (`Service already registered`). `standard` mounts cleanly.

## Versions

- memory-system skill version: `v0.0.1`
- memory format version: `v0.0.1` (the `{version}` path segment)
