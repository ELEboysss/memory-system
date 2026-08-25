// memory-system-hooks — companion hook plugin for the memory-system skill.
//
// This is the HOST half of a Cordis plugin. It enforces the skill's mandatory
// automatic executions ("hooks") by listening to host events and landing files
// directly with the filesystem service:
//
//   - plan mode ends (session/event, plan/mode → active:false) → memory-sync
//   - compaction completes (session/event, compaction/end + checkpoint
//     user/message) → write digest.md, then memory-sync
//   - repository search (tools/post-execute on glob/grep/read/pwsh) → inject
//     the relevant digest into the search result (memory-load)
//   - turn closes (agent/turn-stopping) → incremental memory-sync
//   - agent disposed (agent/disposed) → final memory-sync
//
// Directory spec (skill): the session dir is
// `<repo-root>/.memory/{version}/{date}/{sessionId}` where `sessionId` is
// AGENT-SPECIFIED. The plugin resolves it in this order:
//   1. the id the agent gave `memory_sync_now(sessionId)` (remembered for the
//      session and reused by every hook; call with another id to switch)
//   2. a slug derived from the session title
//   3. a short hash of the dsh session id (never the raw internal UUID)
// `memory-sync` matches by `sessionId` across versions/dates and reuses an
// existing `{session_dir}`; only when none exists it creates one under the
// latest version and today's date.
//
// Usage: paste this file's `return { … }` expression into cordis_define
// (code.host), or mount it as a preset plugin row. It registers one model
// tool, `memory_sync_now(sessionId)`, that forces a sync of the current
// session through the same code path as the hooks.
//
// The plugin writes with the session's resolved sandbox policy, so it obeys
// the same filesystem confinement as the agent's own tools: under the default
// workspace-write mode it can persist `<session-cwd>/.memory/…`.

return {
  name: 'memory-system-hooks',
  inject: ['fs'],
  apply(ctx) {
    const SEARCH_TOOLS = new Set(['glob', 'grep', 'read', 'pwsh']);
    const MEMORY_DIR = '.memory';
    const DIGEST_MAX_CHARS = 2000;
    const MAX_EVENTS = 2000; // rolling window for session/events.jsonl
    const lastSynced = new Map(); // dshSessionId -> last seq appended
    const rootCache = new Map(); // cwd -> repo root
    const agentIds = new Map(); // dshSessionId -> agent-specified sessionId
    const policyService = ctx.get('sandboxPolicy');
    const titleService = ctx.get('sessionTitle');

    const log = (...args) => console.log('[memory-system-hooks]', ...args);
    const err = (...args) => console.error('[memory-system-hooks]', ...args);

    const norm = (p) => String(p).replace(/\\/g, '/');
    const join = (...parts) => parts.map(norm).filter(Boolean).join('/').replace(/\/+/g, '/');

    // Resolve the session's standing sandbox policy so writes obey the same
    // confinement as the agent's own tools (workspace-write by default).
    function policyFor(session) {
      try { return policyService?.resolve({ session }); } catch { return undefined; }
    }

    // sessionId is agent-specified per the skill; sanitized to a safe path
    // segment (lowercase alphanumerics, `-`, `_`).
    function sanitizeSessionId(raw) {
      const slug = String(raw).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      return slug.length > 0 ? slug : undefined;
    }
    function hashId(input) {
      let h = 5381;
      for (let i = 0; i < input.length; i++) h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
      return `session-${h.toString(16).padStart(8, '0')}`;
    }
    function resolveSessionId(session, dshId) {
      const specified = agentIds.get(dshId);
      if (specified) return specified;
      try {
        const title = titleService?.get(session)?.title;
        const slug = sanitizeSessionId(title);
        if (slug) return slug;
      } catch { /* fall through */ }
      return hashId(dshId);
    }

    async function statPath(path) {
      try { return await ctx.fs.stat(await ctx.fs.resolve(path)); } catch { return undefined; }
    }
    async function exists(path) { return (await statPath(path)) !== undefined; }
    async function readTextSafe(path) {
      try { return { ok: true, text: await ctx.fs.readText(await ctx.fs.resolve(path)) }; }
      catch (e) { return { ok: false, error: String(e) }; }
    }
    async function writeTextSafe(path, content, policy) {
      try {
        await ctx.fs.writeText(await ctx.fs.resolve(path), content, undefined, undefined, policy);
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    async function listDirNames(path) {
      try {
        const entries = await ctx.fs.listDir(await ctx.fs.resolve(path));
        return entries.filter((e) => e.type === 'directory').map((e) => e.name);
      } catch { return []; }
    }

    // Walk up from cwd to the nearest `.git` ancestor (falls back to cwd).
    async function findRepoRoot(cwd) {
      if (!cwd) return undefined;
      const key = norm(cwd);
      if (rootCache.has(key)) return rootCache.get(key);
      let cur = key;
      while (true) {
        if (await exists(join(cur, '.git'))) { rootCache.set(key, cur); return cur; }
        const idx = cur.lastIndexOf('/');
        if (idx <= 0) break;
        const parent = cur.slice(0, idx);
        if (parent === cur) break;
        cur = parent;
      }
      rootCache.set(key, key);
      return key;
    }

    function today() {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}${mm}${dd}`;
    }

    // memory-sync matches by {sessionId} across versions/dates and REUSES an
    // existing {session_dir}; only when none exists it creates one under the
    // latest version and today's date. (skill: memory-sync semantics)
    async function resolveSessionDir(repoRoot, sessionId) {
      const memoryRoot = join(repoRoot, MEMORY_DIR);
      const versions = (await listDirNames(memoryRoot)).sort();
      for (let i = versions.length - 1; i >= 0; i--) {
        const dates = (await listDirNames(join(memoryRoot, versions[i]))).sort();
        for (let j = dates.length - 1; j >= 0; j--) {
          const sids = await listDirNames(join(memoryRoot, versions[i], dates[j]));
          if (sids.includes(sessionId)) return { dir: join(memoryRoot, versions[i], dates[j], sessionId), reused: true };
        }
      }
      const version = versions.length ? versions[versions.length - 1] : 'v0.0.1';
      return { dir: join(memoryRoot, version, today(), sessionId), reused: false };
    }

    function sessionOf(agentOrSession) {
      const s = agentOrSession?.session ?? agentOrSession;
      if (!s) return undefined;
      return {
        dshId: String(s.header?.id ?? s.id ?? 'unknown'),
        cwd: s.header?.cwd ?? s.meta?.cwd,
        events: s.events ?? [],
      };
    }

    async function syncSession(session, reason) {
      try {
        const s = sessionOf(session);
        if (!s || !s.cwd) { err('sync skipped: no cwd', reason); return; }
        const sessionId = resolveSessionId(session, s.dshId);
        const policy = policyFor(session);
        const repoRoot = await findRepoRoot(s.cwd);
        const { dir } = await resolveSessionDir(repoRoot, sessionId);
        const events = s.events;
        const lastSeq = lastSynced.get(s.dshId) ?? -1;
        const fresh = events.filter((ev) => Number.isInteger(ev.seq) && ev.seq > lastSeq);
        if (fresh.length === 0) return;
        const logPath = join(dir, 'session', 'events.jsonl');
        const existing = await readTextSafe(logPath);
        const lines = existing.ok && existing.text ? existing.text.trim().split('\n').filter(Boolean) : [];
        for (const ev of fresh) lines.push(JSON.stringify({ seq: ev.seq, type: ev.type, data: ev.data }));
        if (lines.length > MAX_EVENTS) lines.splice(0, lines.length - MAX_EVENTS);
        const w1 = await writeTextSafe(logPath, `${lines.join('\n')}\n`, policy);
        const w2 = await writeTextSafe(join(dir, 'session', 'README.md'),
          `# Session export (memory-system-hooks)\n\n- sessionId: ${sessionId}\n- repo root: ${repoRoot}\n- last sync: ${reason} @ ${new Date().toISOString()}\n- format: JSONL of {seq, type, data} session events, append-only, rolling window of the last ${MAX_EVENTS} events.\n`, policy);
        if (w1.ok && w2.ok) {
          lastSynced.set(s.dshId, events[events.length - 1].seq);
          log('synced', sessionId, reason, fresh.length, 'events ->', dir);
        } else {
          err('sync write failed', reason, w1.error ?? w2.error);
        }
      } catch (e) { err('sync failed', reason, String(e)); }
    }

    // Compaction writes a replacement user/message whose source marks the
    // compact checkpoint; its content IS the compressed memory → digest.md.
    function isCompactCheckpoint(event) {
      const src = event?.data?.source;
      return event?.type === 'user/message' && src?.kind === 'plugin' && src?.plugin === 'compact';
    }

    async function writeDigest(session, event) {
      try {
        const s = sessionOf(session);
        if (!s || !s.cwd) return;
        const sessionId = resolveSessionId(session, s.dshId);
        const policy = policyFor(session);
        const repoRoot = await findRepoRoot(s.cwd);
        const { dir } = await resolveSessionDir(repoRoot, sessionId);
        const blocks = event?.data?.message?.content ?? [];
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
        if (!text) return;
        await writeTextSafe(join(dir, 'digest.md'),
          `# Memory digest\n\n> generated on compaction ${new Date().toISOString()}\n\n${text}\n`, policy);
        log('digest written', sessionId, dir);
      } catch (e) { err('digest failed', String(e)); }
    }

    // Newest digest under the repo's .memory, for search-result injection.
    async function memoryBlockFor(cwd) {
      try {
        if (!cwd) return undefined;
        const repoRoot = await findRepoRoot(cwd);
        const memoryRoot = join(repoRoot, MEMORY_DIR);
        const versions = (await listDirNames(memoryRoot)).sort();
        if (versions.length === 0) return undefined;
        for (let i = versions.length - 1; i >= 0; i--) {
          const version = versions[i];
          const dates = (await listDirNames(join(memoryRoot, version))).sort();
          for (let j = dates.length - 1; j >= 0; j--) {
            const date = dates[j];
            const sessionIds = await listDirNames(join(memoryRoot, version, date));
            for (const sid of sessionIds) {
              const digest = await readTextSafe(join(memoryRoot, version, date, sid, 'digest.md'));
              if (digest.ok) {
                const clipped = digest.text.length > DIGEST_MAX_CHARS ? `${digest.text.slice(0, DIGEST_MAX_CHARS)}\n…(truncated)` : digest.text;
                return { type: 'text', text: `\n[memory-system] 相关仓库记忆 (${version}/${date}/${sid}):\n${clipped}` };
              }
            }
          }
        }
        return undefined;
      } catch (e) { err('memory block failed', String(e)); return undefined; }
    }

    // ── hook: session events (plan-mode end, compaction digest, compaction end) ──
    ctx.on('session/event', (session, event) => {
      if (event?.type === 'plan/mode' && event?.data?.active === false) void syncSession(session, 'plan-mode-end');
      if (event?.type === 'compaction/end') void syncSession(session, 'compaction');
      if (isCompactCheckpoint(event)) void writeDigest(session, event);
    });

    // ── hook: turn close → incremental sync ──
    ctx.on('agent/turn-stopping', (payload) => {
      if (payload?.agent) void syncSession(payload.agent, 'turn-stopping');
    });

    // ── hook: agent disposed → final sync ──
    ctx.on('agent/disposed', (payload) => {
      if (payload?.agent) void syncSession(payload.agent, 'agent-disposed');
    });

    // ── hook: repo search → memory injection ──
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (!exec || exec.signal?.aborted) return next();
      if (!SEARCH_TOOLS.has(exec.name)) return next();
      const downstream = await next();
      if (downstream.kind !== 'accept' || result?.isError) return downstream;
      const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.meta?.cwd;
      const block = await memoryBlockFor(cwd);
      if (!block) return downstream;
      const base = downstream.content ?? result?.content ?? [];
      return { ...downstream, content: [...base, block] };
    });

    // ── model tool: force a sync now; sessionId is agent-specified (skill) ──
    harness.registerTool(ctx, harness.defineTool({
      name: 'memory_sync_now',
      description: 'Force a memory-system sync of the current session. sessionId is required and agent-specified per the skill (e.g. \'my-session\'): it is remembered and reused by the hooks; call again with a different id to switch. Writes <repo-root>/.memory/{version}/{date}/{sessionId}/session/ (same code path as the hooks; existing dirs are matched by sessionId and reused).',
      parameters: { sessionId: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
      async execute(args) {
        const agents = ctx.get('agents');
        let agent;
        try { agent = agents?.requireInitiator?.(); } catch { /* fall through */ }
        if (!agent) agent = agents?.list?.()[0];
        if (!agent?.session) return 'no live agent session to sync';
        const s = sessionOf(agent.session);
        const given = sanitizeSessionId(args?.sessionId);
        if (!given) return 'memory_sync_now requires a non-empty sessionId (agent-specified per the skill)';
        agentIds.set(s.dshId, given);
        const repoRoot = await findRepoRoot(s.cwd);
        const { dir, reused } = await resolveSessionDir(repoRoot, given);
        await syncSession(agent.session, 'tool:memory-sync-now');
        return `memory-sync done -> ${dir} (sessionId: ${given}${reused ? ', reused existing dir' : ', created'})`;
      },
    }));
  },
};
