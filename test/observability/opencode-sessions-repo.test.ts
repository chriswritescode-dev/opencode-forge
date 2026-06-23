import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync } from 'fs'
import { createOpencodeSessionsRepo } from '../../src/observability/opencode-sessions-repo'
import type { OpencodeSessionRow, TranscriptEntry } from '../../src/observability/types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureSession {
  id: string
  project_id?: string | null
  title?: string | null
  directory?: string | null
  agent?: string | null
  model?: string | null
  cost?: number | null
  tokens_input?: number | null
  tokens_output?: number | null
  tokens_reasoning?: number | null
  tokens_cache_read?: number | null
  tokens_cache_write?: number | null
  time_created?: number | null
  time_updated?: number | null
}

interface FixtureProject {
  id: string
  name?: string | null
  worktree?: string | null
}

function createFixtureDb(
  path: string,
  projects: FixtureProject[],
  sessions: FixtureSession[],
): void {
  const db = new Database(path)

  db.run(`CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    name TEXT,
    worktree TEXT NOT NULL DEFAULT ''
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
    title TEXT,
    directory TEXT,
    agent TEXT,
    model TEXT,
    cost REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    time_created INTEGER,
    time_updated INTEGER
  )`)

  // The sessions repo prepares a transcript statement referencing these
  // tables, so they must exist even when unused by a particular test.
  db.run(`CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER
  )`)

  for (const p of projects) {
    db.prepare(
      'INSERT INTO project (id, name, worktree) VALUES ($id, $name, $worktree)',
    ).run({ id: p.id, name: p.name ?? null, worktree: p.worktree ?? null })
  }

  const insertSession = db.prepare(`
    INSERT INTO session (id, project_id, title, directory, agent, model,
      cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES ($id, $projectId, $title, $directory, $agent, $model,
      $cost, $tokensInput, $tokensOutput, $tokensReasoning,
      $tokensCacheRead, $tokensCacheWrite, $timeCreated, $timeUpdated)
  `)
  for (const s of sessions) {
    insertSession.run({
      id: s.id,
      projectId: s.project_id ?? null,
      title: s.title ?? null,
      directory: s.directory ?? null,
      agent: s.agent ?? null,
      model: s.model ?? null,
      cost: s.cost ?? null,
      tokensInput: s.tokens_input ?? null,
      tokensOutput: s.tokens_output ?? null,
      tokensReasoning: s.tokens_reasoning ?? null,
      tokensCacheRead: s.tokens_cache_read ?? null,
      tokensCacheWrite: s.tokens_cache_write ?? null,
      timeCreated: s.time_created ?? null,
      timeUpdated: s.time_updated ?? null,
    })
  }

  db.close()
}

// ---------------------------------------------------------------------------
// Transcript fixture types and helper (shared across describe blocks)
// ---------------------------------------------------------------------------

interface FixtureMessage {
  id: string
  session_id: string
  data: string
  time_created: number
}

interface FixturePart {
  id: string
  message_id: string
  session_id: string
  data: string
  time_created: number
}

function createTranscriptFixtureDb(
  path: string,
  messages: FixtureMessage[],
  parts: FixturePart[],
): void {
  const db = new Database(path)

  // The sessions repo prepares statements referencing session/project too,
  // so they must exist even when unused by transcript tests.
  db.run(`CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    name TEXT,
    worktree TEXT NOT NULL DEFAULT ''
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
    title TEXT,
    directory TEXT,
    agent TEXT,
    model TEXT,
    cost REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    time_created INTEGER,
    time_updated INTEGER
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER
  )`)

  const insertMsg = db.prepare(
    'INSERT INTO message (id, session_id, data, time_created) VALUES ($id, $sessionId, $data, $timeCreated)',
  )
  for (const m of messages) {
    insertMsg.run({
      id: m.id,
      sessionId: m.session_id,
      data: m.data,
      timeCreated: m.time_created,
    })
  }

  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, data, time_created) VALUES ($id, $messageId, $sessionId, $data, $timeCreated)',
  )
  for (const p of parts) {
    insertPart.run({
      id: p.id,
      messageId: p.message_id,
      sessionId: p.session_id,
      data: p.data,
      timeCreated: p.time_created,
    })
  }

  db.close()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpencodeSessionsRepo', () => {
  let tmpPath: string
  let db: Database

  beforeEach(() => {
    tmpPath = `/tmp/opencode-sessions-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  })

  afterEach(() => {
    if (db && !db.closed) db.close()
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  })

  /** Open the fixture DB readonly and create the repo. */
  function openRepo(): ReturnType<typeof createOpencodeSessionsRepo> {
    db = new Database(tmpPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    return createOpencodeSessionsRepo(db)
  }

  // -----------------------------------------------------------------------
  // Ordering, limit, and basic mapping
  // -----------------------------------------------------------------------

  test('returns sessions ordered by time_updated DESC', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'My Project', worktree: '/work/my-project' }],
      [
        { id: 'ses_1', project_id: 'proj_1', time_updated: 100, cost: 0.5, tokens_input: 100, tokens_output: 50, tokens_reasoning: 10, tokens_cache_read: 20, tokens_cache_write: 5, directory: '/dir/a' },
        { id: 'ses_2', project_id: 'proj_1', time_updated: 300, cost: 1.0, tokens_input: 200, tokens_output: 100, tokens_reasoning: 20, tokens_cache_read: 40, tokens_cache_write: 10, directory: '/dir/b' },
        { id: 'ses_3', project_id: 'proj_1', time_updated: 200, cost: 0.75, tokens_input: 150, tokens_output: 75, tokens_reasoning: 15, tokens_cache_read: 30, tokens_cache_write: 8, directory: '/dir/c' },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows).toHaveLength(3)
    expect(rows[0].id).toBe('ses_2')
    expect(rows[1].id).toBe('ses_3')
    expect(rows[2].id).toBe('ses_1')
  })

  test('respects limit parameter and clamps it', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      Array.from({ length: 10 }, (_, i) => ({
        id: `ses_${i}`,
        project_id: 'proj_1',
        time_updated: i * 10,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })),
    )
    const repo = openRepo()

    // Default limit = 50, but only 10 rows exist
    expect(repo.listRecentSessions()).toHaveLength(10)

    // Explicit limit
    expect(repo.listRecentSessions(3)).toHaveLength(3)

    // Clamped to max 200
    expect(repo.listRecentSessions(999)).toHaveLength(10)

    // Clamped to min 1
    expect(repo.listRecentSessions(-5)).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // Model JSON parsing
  // -----------------------------------------------------------------------

  test('parses model JSON with providerID (uppercase D)', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          model: JSON.stringify({ id: 'claude-opus-4-8', providerID: 'anthropic' }),
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows).toHaveLength(1)
    expect(rows[0].modelId).toBe('claude-opus-4-8')
    expect(rows[0].providerId).toBe('anthropic')
  })

  test('parses model JSON with providerId (lowercase d)', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          model: JSON.stringify({ id: 'gpt-4', providerId: 'openai' }),
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].modelId).toBe('gpt-4')
    expect(rows[0].providerId).toBe('openai')
  })

  test('returns modelId=null and providerId=null when model is NULL', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          model: null,
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].modelId).toBeNull()
    expect(rows[0].providerId).toBeNull()
  })

  test('falls back to raw string as modelId when model JSON is invalid', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          model: 'not-json',
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].modelId).toBe('not-json')
    expect(rows[0].providerId).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Project name fallback
  // -----------------------------------------------------------------------

  test('projectName comes from project.name when set', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'My Project', worktree: '/work/my-project' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          directory: '/some/deep/path',
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].projectName).toBe('My Project')
  })

  test('projectName falls back to basename(directory) when project.name is NULL', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: null, worktree: '/some/worktree' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          directory: '/home/user/projects/my-app',
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].projectName).toBe('my-app')
  })

  test('projectName falls back to basename when session has no project_id', () => {
    createFixtureDb(
      tmpPath,
      [],
      [
        {
          id: 'ses_1',
          project_id: null,
          directory: '/some/other/project-x',
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].projectName).toBe('project-x')
  })

  test('projectName is null when both project.name and directory are null', () => {
    createFixtureDb(
      tmpPath,
      [],
      [
        {
          id: 'ses_1',
          project_id: null,
          directory: null,
          time_updated: 100,
          cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].projectName).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Numeric defaults
  // -----------------------------------------------------------------------

  test('numeric columns default to 0 when NULL in the database', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'P', worktree: '' }],
      [
        {
          id: 'ses_1',
          project_id: 'proj_1',
          // Explicitly set all numerics to NULL
          cost: null,
          tokens_input: null,
          tokens_output: null,
          tokens_reasoning: null,
          tokens_cache_read: null,
          tokens_cache_write: null,
          time_updated: 100,
        },
      ],
    )
    const repo = openRepo()
    const rows = repo.listRecentSessions()

    expect(rows[0].cost).toBe(0)
    expect(rows[0].tokensInput).toBe(0)
    expect(rows[0].tokensOutput).toBe(0)
    expect(rows[0].tokensReasoning).toBe(0)
    expect(rows[0].tokensCacheRead).toBe(0)
    expect(rows[0].tokensCacheWrite).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Full row mapping smoke test
  // -----------------------------------------------------------------------

  test('maps all fields correctly for a complete row', () => {
    createFixtureDb(
      tmpPath,
      [{ id: 'proj_1', name: 'Test Proj', worktree: '/wt' }],
      [
        {
          id: 'ses_full',
          project_id: 'proj_1',
          directory: '/dir',
          agent: 'test-agent',
          model: JSON.stringify({ id: 'claude-3', providerID: 'anthropic' }),
          cost: 1.5,
          tokens_input: 200,
          tokens_output: 100,
          tokens_reasoning: 25,
          tokens_cache_read: 50,
          tokens_cache_write: 10,
          time_created: 1000,
          time_updated: 2000,
        },
      ],
    )
    const repo = openRepo()
    const [row] = repo.listRecentSessions()

    expect(row).toEqual<OpencodeSessionRow>({
      id: 'ses_full',
      title: null,
      directory: '/dir',
      projectName: 'Test Proj',
      worktree: '/wt',
      agent: 'test-agent',
      modelId: 'claude-3',
      providerId: 'anthropic',
      cost: 1.5,
      tokensInput: 200,
      tokensOutput: 100,
      tokensReasoning: 25,
      tokensCacheRead: 50,
      tokensCacheWrite: 10,
      timeCreated: 1000,
      timeUpdated: 2000,
    })
  })

})

// ---------------------------------------------------------------------------
// getSessionTranscript
// ---------------------------------------------------------------------------

describe('getSessionTranscript', () => {
  let tmpPath: string
  let db: Database
  let repo: ReturnType<typeof createOpencodeSessionsRepo>

  beforeEach(() => {
    tmpPath = `/tmp/opencode-transcript-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  })

  afterEach(() => {
    if (db && !db.closed) db.close()
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  })

  function openRepoReadonly(): void {
    db = new Database(tmpPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    repo = createOpencodeSessionsRepo(db)
  }

  // -----------------------------------------------------------------------
  // Ordering
  // -----------------------------------------------------------------------

  test('returns entries ordered by message time ASC, then part time ASC, then part id ASC', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_early', session_id: 'ses_test', data: JSON.stringify({ role: 'user' }), time_created: 50 },
        { id: 'msg_late', session_id: 'ses_test', data: JSON.stringify({ role: 'assistant' }), time_created: 200 },
      ],
      [
        { id: 'part_b', message_id: 'msg_early', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'second' }), time_created: 20 },
        { id: 'part_a', message_id: 'msg_early', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'first' }), time_created: 10 },
        { id: 'part_c', message_id: 'msg_late', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'third' }), time_created: 5 },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(3)
    expect(entries[0].text).toBe('first')
    expect(entries[1].text).toBe('second')
    expect(entries[2].text).toBe('third')
    // messageId reflects the owning message
    expect(entries[0].messageId).toBe('msg_early')
    expect(entries[2].messageId).toBe('msg_late')
  })

  // -----------------------------------------------------------------------
  // Text part
  // -----------------------------------------------------------------------

  test('extracts text part with role from message data', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'user' }), time_created: 100 },
      ],
      [
        { id: 'part_1', message_id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'Hello world' }), time_created: 10 },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual<TranscriptEntry>({
      partId: 'part_1',
      messageId: 'msg_1',
      role: 'user',
      model: null,
      type: 'text',
      text: 'Hello world',
      toolName: null,
      toolTitle: null,
      toolStatus: null,
      timeCreated: 10,
    })
  })

  // -----------------------------------------------------------------------
  // Tool part
  // -----------------------------------------------------------------------

  test('extracts tool part with toolName, toolTitle, and toolStatus', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'assistant', modelID: 'claude-opus-4-8' }), time_created: 100 },
      ],
      [
        {
          id: 'part_1',
          message_id: 'msg_1',
          session_id: 'ses_test',
          data: JSON.stringify({
            type: 'tool',
            tool: 'read',
            state: { status: 'complete', title: 'Read file', input: { description: 'Read /path' } },
          }),
          time_created: 10,
        },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual<TranscriptEntry>({
      partId: 'part_1',
      messageId: 'msg_1',
      role: 'assistant',
      model: 'claude-opus-4-8',
      type: 'tool',
      text: null,
      toolName: 'read',
      toolTitle: 'Read file',
      toolStatus: 'complete',
      timeCreated: 10,
    })
  })

  test('falls back toolTitle to state.input.description when state.title is missing', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'assistant' }), time_created: 100 },
      ],
      [
        {
          id: 'part_1',
          message_id: 'msg_1',
          session_id: 'ses_test',
          data: JSON.stringify({
            type: 'tool',
            tool: 'write',
            state: { status: 'running', input: { description: 'Write to file' } },
          }),
          time_created: 10,
        },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0].toolTitle).toBe('Write to file')
    expect(entries[0].toolStatus).toBe('running')
  })

  test('handles tool part with no state object', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'assistant' }), time_created: 100 },
      ],
      [
        {
          id: 'part_1',
          message_id: 'msg_1',
          session_id: 'ses_test',
          data: JSON.stringify({ type: 'tool', tool: 'think' }),
          time_created: 10,
        },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0].toolName).toBe('think')
    expect(entries[0].toolTitle).toBeNull()
    expect(entries[0].toolStatus).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Part-type filter
  // -----------------------------------------------------------------------

  test('excludes non-text/tool parts (e.g. step-start)', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'assistant' }), time_created: 100 },
      ],
      [
        { id: 'part_step', message_id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ type: 'step-start' }), time_created: 5 },
        { id: 'part_text', message_id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'Hello' }), time_created: 10 },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('text')
    expect(entries[0].text).toBe('Hello')
  })

  // -----------------------------------------------------------------------
  // Malformed JSON
  // -----------------------------------------------------------------------

  test('skips malformed JSON part data without throwing', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'user' }), time_created: 100 },
      ],
      [
        { id: 'part_valid', message_id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ type: 'text', text: 'valid' }), time_created: 10 },
        { id: 'part_bad', message_id: 'msg_1', session_id: 'ses_test', data: 'not-json', time_created: 20 },
      ],
    )
    openRepoReadonly()
    const entries = repo.getSessionTranscript('ses_test')

    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('valid')
  })

  // -----------------------------------------------------------------------
  // Limit
  // -----------------------------------------------------------------------

  test('respects the limit parameter', () => {
    createTranscriptFixtureDb(
      tmpPath,
      [
        { id: 'msg_1', session_id: 'ses_test', data: JSON.stringify({ role: 'user' }), time_created: 100 },
      ],
      Array.from({ length: 5 }, (_, i) => ({
        id: `part_${i}`,
        message_id: 'msg_1',
        session_id: 'ses_test',
        data: JSON.stringify({ type: 'text', text: `entry-${i}` }),
        time_created: i,
      })),
    )
    openRepoReadonly()

    expect(repo.getSessionTranscript('ses_test', 2)).toHaveLength(2)
    expect(repo.getSessionTranscript('ses_test', 99)).toHaveLength(5)
  })
})
