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

  test('status badges are rendered as clickable filter badges', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('badge-filter')
    expect(html).toContain('activeStatuses')
  })

  test('defines active filter styling', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('badge-active')
  })

  test('status filter uses OR membership check', () => {
    const html = renderDashboardHtml()

    expect(html).toMatch(/activeStatuses\.has\(/)
  })

  test('renders a search input', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('id="loop-search"')
  })

  test('search input has styling', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('search-input')
  })

  test('search binds an input handler that sets searchText', () => {
    const html = renderDashboardHtml()

    expect(html).toMatch(new RegExp("addEventListener\\(\\s*['\"]input['\"]"))
    expect(html).toContain('searchText')
  })

  test('caches last payload for filter re-render', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('lastData')
  })

  test('renders a master-detail layout with project sidebar and detail pane', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('dash-layout')
    expect(html).toContain('project-sidebar')
    expect(html).toContain('project-detail')
  })

  test('tracks the selected project in state', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('selectedProjectId')
  })

  test('sidebar project items toggle the selected project on click', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('project-nav-item')
    // Sidebar click routes through navigate(), which assigns the selected project
    expect(html).toMatch(/navigate\(pid,\s*null\)/)
    expect(html).toMatch(/function navigate\(projectId, loopName\)[\s\S]*?selectedProjectId\s*=\s*projectId/)
  })

  test('shows loop counts per project in the sidebar', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('project-nav-count')
  })

  test('renders an empty state when no loops match filters', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('empty-state')
  })

  test('inline client script is syntactically valid JavaScript', () => {
    const html = renderDashboardHtml()
    const match = html.match(/<script>([\s\S]*?)<\/script>/)

    expect(match).not.toBeNull()
    const script = match![1]
    expect(() => new Function(script)).not.toThrow()
  })

  test('derives the sidebar label from the last path segment', () => {
    const html = renderDashboardHtml()
    const match = html.match(/<script>([\s\S]*?)<\/script>/)
    const script = match![1]

    const lastSegment = new Function(
      'rawPath',
      script.replace(/[\s\S]*?(var rawSegments = [\s\S]*?navName\.title = rawPath;)[\s\S]*/, `
        var navName = { textContent: '', title: '' };
        $1
        return navName.textContent;
      `)
    )

    expect(lastSegment('/Users/chris/development/opencode-forge')).toBe('opencode-forge')
    expect(lastSegment('simple-id')).toBe('simple-id')
    expect(lastSegment('')).toBe('')
  })

  test('defines selectedLoopName state and hash sync', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('selectedLoopName')
    expect(html).toContain('hashchange')
    expect(html).toContain('location.hash')
  })

  test('parseLoopHash/buildLoopHash round-trip', () => {
    const html = renderDashboardHtml()
    const match = html.match(/<script>([\s\S]*?)<\/script>/)
    const script = match![1]

    const parseLoopHashSrc = script.match(/function parseLoopHash\(hash\) \{[\s\S]*?\n    \}/)![0]
    const buildLoopHashSrc = script.match(/function buildLoopHash\(projectId, loopName\) \{[\s\S]*?\n    \}/)![0]

    const helpers = new Function(
      parseLoopHashSrc + '\n' + buildLoopHashSrc + '\nreturn { parseLoopHash, buildLoopHash };'
    )()

    expect(helpers.buildLoopHash('/Users/x/proj', 'my-loop'))
      .toBe('#' + encodeURIComponent('/Users/x/proj') + '/' + encodeURIComponent('my-loop'))
    expect(helpers.parseLoopHash(helpers.buildLoopHash('/Users/x/proj', 'my-loop')))
      .toEqual({ projectId: '/Users/x/proj', loopName: 'my-loop' })
    expect(helpers.parseLoopHash('')).toEqual({ projectId: null, loopName: null })
    expect(helpers.buildLoopHash(null, null)).toBe('')
  })

  test('renders a loop list that navigates to a single-loop detail', () => {
    const html = renderDashboardHtml()

    // buildLoopRow's click handler captures lp.loopName as 'name' and routes through navigate()
    expect(html).toMatch(/navigate\(selectedProjectId,\s*name\)/)
    // navigate() is the single source that sets the selected loop
    expect(html).toMatch(/function navigate\(projectId, loopName\)[\s\S]*?selectedLoopName\s*=\s*loopName/)
    // Detail view has a back-to-loops control
    expect(html).toContain('back-to-loops')
  })

  test('defines resizable block styling for long-text areas', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('resizable-block')
    expect(html).toContain('resize: both')
  })

  test('clears selected loop when switching projects', () => {
    const html = renderDashboardHtml()

    // Sidebar click handler resets selectedLoopName to null when switching projects
    expect(html).toMatch(/selectedLoopName\s*=\s*null/)
  })

  test('clears selected loop name when falling back to first visible project', () => {
    const html = renderDashboardHtml()

    // When the selected project is filtered out or missing, render() falls back
    // to matchedByProject[0] and must also clear selectedLoopName to avoid
    // opening a same-named loop from an unrelated project.
    expect(html).toMatch(/if\s*\(!selectedEntry\)\s*\{[\s\S]*?selectedLoopName\s*=\s*null/)
  })
})
