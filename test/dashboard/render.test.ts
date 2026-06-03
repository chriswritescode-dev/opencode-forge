import { describe, test, expect } from 'bun:test'
import { renderDashboardHtml } from '../../src/dashboard/render'

describe('renderDashboardHtml', () => {
  // ─── Cycle 1: structure ──────────────────────────────────────────────

  test('contains DOCTYPE html, title, and mount node', () => {
    const html = renderDashboardHtml()

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<title>Forge Dashboard</title>')
    expect(html).toContain('id="forge-dashboard"')
  })

  // ─── Cycle 2: fetch endpoint ─────────────────────────────────────────

  test('client script fetches /api/data', () => {
    const html = renderDashboardHtml()

    // Accept either single or double quotes
    expect(html).toMatch(/fetch\s*\(\s*["']\/api\/data["']/)
  })

  // ─── Cycle 3: polling ────────────────────────────────────────────────

  test('includes setInterval for live refresh', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('setInterval')
  })

  // ─── Cycle 4: safe injection (no innerHTML for content) ──────────────

  test('does not use innerHTML for content injection', () => {
    const html = renderDashboardHtml()

    // The script must not assign innerHTML for dynamic content.
    // Allow only if it's for static template initialization (none expected).
    // We check that the pattern ".innerHTML =" does NOT appear anywhere.
    expect(html).not.toMatch(/\.innerHTML\s*=/)
  })
})
