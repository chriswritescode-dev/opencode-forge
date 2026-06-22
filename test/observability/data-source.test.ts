import { describe, test, expect, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync } from 'fs'
import { createOpencodeDataSource } from '../../src/observability/data-source'
import type { OpencodeDataSource } from '../../src/observability/data-source'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createFixtureDb(path: string): void {
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

  db.prepare(
    'INSERT INTO project (id, name, worktree) VALUES ($id, $name, $worktree)',
  ).run({ id: 'proj_1', name: 'Test Project', worktree: '/wt' })

  const insertSession = db.prepare(`
    INSERT INTO session (id, project_id, title, directory, agent, model,
      cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES ($id, $projectId, $title, $directory, $agent, $model,
      $cost, $tokensInput, $tokensOutput, $tokensReasoning,
      $tokensCacheRead, $tokensCacheWrite, $timeCreated, $timeUpdated)
  `)

  insertSession.run({
    id: 'ses_1',
    projectId: 'proj_1',
    title: 'First Session',
    directory: '/dir/a',
    agent: 'agent-1',
    model: JSON.stringify({ id: 'claude-3', providerID: 'anthropic' }),
    cost: 0.5,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: 10,
    tokensCacheRead: 20,
    tokensCacheWrite: 5,
    timeCreated: 1000,
    timeUpdated: 2000,
  })

  insertSession.run({
    id: 'ses_2',
    projectId: 'proj_1',
    title: 'Second Session',
    directory: '/dir/b',
    agent: 'agent-2',
    model: JSON.stringify({ id: 'gpt-4', providerId: 'openai' }),
    cost: 1.0,
    tokensInput: 200,
    tokensOutput: 100,
    tokensReasoning: 20,
    tokensCacheRead: 40,
    tokensCacheWrite: 10,
    timeCreated: 3000,
    timeUpdated: 4000,
  })

  // Also add a transcript part for transcript tests
  db.prepare(
    'INSERT INTO message (id, session_id, data, time_created) VALUES ($id, $sessionId, $data, $timeCreated)',
  ).run({
    id: 'msg_1',
    sessionId: 'ses_1',
    data: JSON.stringify({ role: 'user' }),
    timeCreated: 100,
  })

  db.prepare(
    'INSERT INTO part (id, message_id, session_id, data, time_created) VALUES ($id, $messageId, $sessionId, $data, $timeCreated)',
  ).run({
    id: 'part_1',
    messageId: 'msg_1',
    sessionId: 'ses_1',
    data: JSON.stringify({ type: 'text', text: 'Hello from test' }),
    timeCreated: 10,
  })

  db.close()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpencodeDataSource', () => {
  let tmpPath: string
  let ds: OpencodeDataSource

  afterEach(() => {
    if (ds && typeof ds.close === 'function') {
      ds.close()
    }
    if (tmpPath && existsSync(tmpPath)) {
      unlinkSync(tmpPath)
    }
  })

  // ── Unavailable path ──────────────────────────────────────────────────

  test('returns available=false when DB file does not exist', () => {
    const ds = createOpencodeDataSource({ path: '/tmp/nonexistent-opencode-test.db' })
    expect(ds.available).toBe(false)
  })

  test('listRecentSessions returns [] when unavailable', () => {
    const ds = createOpencodeDataSource({ path: '/tmp/nonexistent-opencode-test-2.db' })
    expect(ds.listRecentSessions()).toEqual([])
  })

  test('getSessionTranscript returns [] when unavailable', () => {
    const ds = createOpencodeDataSource({ path: '/tmp/nonexistent-opencode-test-3.db' })
    expect(ds.getSessionTranscript('any-id')).toEqual([])
  })

  test('close is a no-op when unavailable', () => {
    const ds = createOpencodeDataSource({ path: '/tmp/nonexistent-opencode-test-4.db' })
    expect(() => ds.close()).not.toThrow()
  })

  // ── Available path with fixture data ──────────────────────────────────

  test('returns available=true when DB opens successfully', () => {
    tmpPath = `/tmp/opencode-ds-test-avail-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })
    expect(ds.available).toBe(true)
  })

  test('listRecentSessions returns sessions ordered by time_updated DESC', () => {
    tmpPath = `/tmp/opencode-ds-test-list-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })

    const sessions = ds.listRecentSessions()
    expect(sessions).toHaveLength(2)
    // ses_2 has time_updated=4000, ses_1 has 2000 → ses_2 first
    expect(sessions[0].id).toBe('ses_2')
    expect(sessions[1].id).toBe('ses_1')
  })

  test('listRecentSessions respects limit parameter', () => {
    tmpPath = `/tmp/opencode-ds-test-limit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })

    expect(ds.listRecentSessions(1)).toHaveLength(1)
    expect(ds.listRecentSessions(10)).toHaveLength(2)
  })

  test('getSessionTranscript returns entries for a valid session', () => {
    tmpPath = `/tmp/opencode-ds-test-trans-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })

    const entries = ds.getSessionTranscript('ses_1')
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Hello from test')
    expect(entries[0].messageId).toBe('msg_1')
  })

  test('getSessionTranscript returns [] for unknown session', () => {
    tmpPath = `/tmp/opencode-ds-test-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })

    expect(ds.getSessionTranscript('nonexistent')).toEqual([])
  })

  // ── close idempotency ─────────────────────────────────────────────────

  test('close is idempotent', () => {
    tmpPath = `/tmp/opencode-ds-test-close-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })
    expect(ds.available).toBe(true)

    ds.close()
    // Calling close again should not throw
    expect(() => ds.close()).not.toThrow()
  })

  test('queries return [] after close', () => {
    tmpPath = `/tmp/opencode-ds-test-afterclose-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    createFixtureDb(tmpPath)
    ds = createOpencodeDataSource({ path: tmpPath })
    ds.close()

    // After close, the prepared statements are invalid, so try/catch returns []
    expect(ds.listRecentSessions()).toEqual([])
    expect(ds.getSessionTranscript('ses_1')).toEqual([])
  })
})
