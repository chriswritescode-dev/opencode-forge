import { describe, test, expect } from 'vitest'
import { renderDashboardHtml } from '../../src/dashboard/render'

describe('renderDashboardHtml', () => {
  test('contains DOCTYPE html, title, and a single forge-app-root mount node', () => {
    const html = renderDashboardHtml()

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<title>Forge Dashboard</title>')
    expect(html).toContain('id="forge-app-root"')
    expect(html.match(/id="forge-app-root"/g)).toHaveLength(1)
  })

  test('inlines the marked source before the module script', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('marked v12')
    // marked script must appear before the module script
    const markedIdx = html.indexOf('marked v12')
    const moduleIdx = html.indexOf('type="module"')
    expect(markedIdx).toBeGreaterThan(0)
    expect(moduleIdx).toBeGreaterThan(markedIdx)
  })

  test('inlines the app bundle as a deferred module script', () => {
    const html = renderDashboardHtml()

    expect(html).toContain('<script type="module">')
    expect(html).toContain('/api/data')
    expect(html).toContain('forge-app-root')
  })

  test('retains CSS class definitions for dashboard components', () => {
    const html = renderDashboardHtml()

    const cssClasses = [
      'badge-filter',
      'badge-active',
      'view-tabs',
      'view-tab-active',
      '#fe7d37',
      'search-input',
      'dash-layout',
      'project-sidebar',
      'project-detail',
      'project-nav-item',
      'project-nav-count',
      'empty-state',
      'resizable-block',
      'resize: vertical',
      'back-to-loops',
      'session-layout',
      'session-project-sidebar',
      'session-project-nav-item',
      'session-project-nav-item.selected',
      'session-project-nav-name',
      'session-project-nav-count',
      'session-detail',
      'session-project-header',
      'session-group-count',
    ]
    for (const cls of cssClasses) {
      expect(html).toContain(cls)
    }
  })

  test('no longer contains inline script or old static dashboard nodes', () => {
    const html = renderDashboardHtml()

    // The old inline script tag is gone
    expect(html).not.toContain('<script id="forge-app">')
    // The old forge-dashboard mount is gone (replaced by forge-app-root)
    expect(html).not.toContain('id="forge-dashboard"')
    // The old static nodes are gone (totals-bar, timestamp, loop-search
    // may appear as string literals in the inlined bundle, but there is
    // no static <div id="totals-bar"> in the shell)
    expect(html).not.toContain('<div id="totals-bar"')
  })
})
