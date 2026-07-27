import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderDashboardHtml } from '../../src/dashboard/render'

const APP_DIR = join(__dirname, '../../src/dashboard/app')

/**
 * Static `class="…"` tokens emitted by the browser app. Templates that build a
 * class name by concatenation (`'status-' + status`) are not visible here, so
 * this is a lower bound, not a complete inventory.
 */
function staticAppClassNames(): string[] {
  const tokens = new Set<string>()
  for (const file of readdirSync(APP_DIR)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(join(APP_DIR, file), 'utf8')
    for (const match of source.matchAll(/class="([^"$]+)"/g)) {
      for (const token of match[1].trim().split(/\s+/)) {
        if (token) tokens.add(token)
      }
    }
  }
  return [...tokens].sort()
}

/**
 * Layout wrappers, semantic hooks, and test selectors that deliberately carry
 * no rule of their own. Everything else must be styled: render.ts holds the
 * only stylesheet, so a class it does not define ships as unstyled markup.
 */
const UNSTYLED_BY_DESIGN = new Set([
  'forge-app',
  'group-row-completed',
  'group-row-created',
  'loop-picker-input',
  'lt-findings',
  'markdown-section',
  'mg-edge', // SVG group wrapper for edge path + label
  'overview-tab',
  'plan-tab',
  'repo-loop-pane',
  'section-drill', // container for section drill-down view
  'tab-bodies',
  'timeline-tab',
  'usage-tab',
])

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

  test('every static class the app emits has a rule in the stylesheet', () => {
    const html = renderDashboardHtml()
    const style = html.slice(0, html.indexOf('</style>'))
    const unstyled = staticAppClassNames().filter(
      cls => !UNSTYLED_BY_DESIGN.has(cls) && !style.match(new RegExp(`\\.${cls}(?![\\w-])`)),
    )

    expect(unstyled).toEqual([])
  })

  test('the unstyled-by-design allowlist has no stale entries', () => {
    const emitted = new Set(staticAppClassNames())
    const stale = [...UNSTYLED_BY_DESIGN].filter(cls => !emitted.has(cls))

    expect(stale).toEqual([])
  })

  test('the markdown body renders at full height instead of scrolling internally', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const start = style.indexOf('.markdown-body')
    const rule = style.slice(start, style.indexOf('}', start))

    expect(start).toBeGreaterThan(0)
    expect(rule).not.toContain('max-height')
    expect(rule).not.toContain('overflow')
  })

  test('markdown headings use the accent color to stand out from body text', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    for (const level of ['h1', 'h2', 'h3', 'h4']) {
      const start = style.indexOf(`.markdown-content ${level} `)
      expect(start).toBeGreaterThan(0)
      const rule = style.slice(start, style.indexOf('}', start))
      expect(rule).toContain('var(--accent)')
      expect(rule).not.toContain('var(--fg-bright)')
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

  test('defines design tokens and contains no literal hex outside :root', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    expect(style).toContain('--bg-0:')
    expect(style).toContain('--accent:')
    expect(style).toContain('--ph-coding:')
    const afterRoot = style.slice(style.indexOf('}', style.indexOf(':root')))
    expect(afterRoot).not.toMatch(/#[0-9a-fA-F]{6}\b/)
  })
})
