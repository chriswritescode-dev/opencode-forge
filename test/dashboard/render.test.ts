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

    // The script must not assign innerHTML for dynamic content, with one
    // exception: rendered markdown is assigned from marked.parse(...), which
    // produces trusted HTML from forge-owned plan/audit/summary content.
    const innerHtmlAssignments = html.match(/\.innerHTML\s*=[^;\n]*/g) || []
    const disallowed = innerHtmlAssignments.filter(
      (assignment) => !/\.innerHTML\s*=\s*marked\.parse\(/.test(assignment),
    )
    expect(disallowed).toEqual([])
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
    const match = html.match(/<script id="forge-app">([\s\S]*?)<\/script>/)

    expect(match).not.toBeNull()
    const script = match![1]
    expect(() => new Function(script)).not.toThrow()
  })

  test('derives the sidebar label from the last path segment', () => {
    const html = renderDashboardHtml()
    const match = html.match(/<script id="forge-app">([\s\S]*?)<\/script>/)
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
    const match = html.match(/<script id="forge-app">([\s\S]*?)<\/script>/)
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

  test('caches rendered markdown so unchanged sections are not re-parsed or rebuilt', () => {
    const html = renderDashboardHtml()
    const match = html.match(/<script id="forge-app">([\s\S]*?)<\/script>/)
    const script = match![1]

    const cacheDeclSrc = script.match(/var markdownCache = \{\};/)![0]
    const appendSrc = script.match(/function appendMarkdownSection\(parent, cacheKey, label, src\) \{[\s\S]*?\n    \}/)![0]

    // Fake DOM that counts marked.parse calls and tracks appended children.
    const harness = new Function(
      'parseImpl',
      `
      var parseCalls = 0;
      var marked = { parse: function(src) { parseCalls++; return parseImpl(src); } };
      function makeEl() {
        return {
          className: '', textContent: '', innerHTML: '', children: [],
          appendChild: function(c) { this.children.push(c); return c; },
        };
      }
      var document = { createElement: function() { return makeEl(); } };
      ${cacheDeclSrc}
      ${appendSrc}
      return {
        run: function(key, src) {
          var parent = makeEl();
          appendMarkdownSection(parent, key, 'Plan', src);
          return parent;
        },
        stats: function() { return { parseCalls: parseCalls }; },
      };
      `,
    )((src: string) => '<p>' + src + '</p>')

    // First render of a section parses once and caches the wrapper.
    const first = harness.run('loopA::plan', '# Plan v1')
    const firstWrap = first.children[first.children.length - 1]
    expect(harness.stats().parseCalls).toBe(1)

    // Re-render with identical source reuses the SAME wrapper node (scroll preserved)
    // and does not call marked.parse again.
    const second = harness.run('loopA::plan', '# Plan v1')
    const secondWrap = second.children[second.children.length - 1]
    expect(harness.stats().parseCalls).toBe(1)
    expect(secondWrap).toBe(firstWrap)

    // Changed source re-parses and produces a fresh wrapper.
    const third = harness.run('loopA::plan', '# Plan v2')
    const thirdWrap = third.children[third.children.length - 1]
    expect(harness.stats().parseCalls).toBe(2)
    expect(thirdWrap).not.toBe(firstWrap)
  })
})
