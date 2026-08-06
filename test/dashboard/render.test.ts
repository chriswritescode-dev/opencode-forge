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

  test('every font-family outside :root resolves through a token', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const afterRoot = style.slice(style.indexOf('}', style.indexOf(':root')))
    expect(afterRoot).not.toMatch(/font-family:\s*(?!\s*var\()/)
  })

  test('sub-1rem font sizes resolve through the type scale', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const afterRoot = style.slice(style.indexOf('}', style.indexOf(':root')))
    expect(afterRoot).not.toMatch(/font-size:\s*0\.\d+rem/)
  })

  test('the type scale and spacing scale are fully consumed', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const root = style.slice(style.indexOf(':root'), style.indexOf('}', style.indexOf(':root')))
    const declared = new Set([...root.matchAll(/--((?:fs|sp)-[a-zA-Z0-9-]+):/g)].map(m => `--${m[1]}`))
    const afterRoot = style.slice(style.indexOf('}', style.indexOf(':root')))
    const unreferenced = [...declared].filter(name => !afterRoot.includes(`var(${name})`))

    expect(unreferenced).toEqual([])
  })

  test('the stylesheet defines no unreferenced custom properties', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const root = style.slice(style.indexOf(':root'), style.indexOf('}', style.indexOf(':root')))
    const declared = new Set([...root.matchAll(/--([a-zA-Z0-9-]+):/g)].map(m => `--${m[1]}`))
    // References include the inlined app bundle, which sets inline styles
    // through var() tokens (e.g. the usage-stack segments).
    const referenced = new Set([...html.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map(m => m[1]))
    const unreferenced = [...declared].filter(name => !referenced.has(name))

    expect(unreferenced).toEqual([])
  })

  test('status and phase families are distinct tokens', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    for (const token of [
      '--status-running', '--status-ok', '--status-error',
      '--status-attention', '--status-idle', '--fg-muted',
      '--ph-work', '--ph-review', '--ph-wrap',
    ]) {
      expect(style).toContain(`${token}:`)
    }
    const root = style.slice(style.indexOf(':root'), style.indexOf('}', style.indexOf(':root')))
    const resolved = new Map<string, string>()
    for (const match of root.matchAll(/--([a-zA-Z0-9-]+):\s*([^;]+);/g)) {
      resolved.set(`--${match[1]}`, match[2].trim())
    }
    const resolve = (name: string, seen: Set<string> = new Set()): string => {
      if (seen.has(name)) return ''
      seen.add(name)
      const value = resolved.get(name)
      const ref = value?.match(/^var\((--[a-zA-Z0-9-]+)\)$/)
      return ref ? resolve(ref[1], seen) : value ?? ''
    }
    const phaseTokens = ['--ph-coding', '--ph-auditing', '--ph-final-auditing', '--ph-final-audit-fix', '--ph-post-action']
    const literals = phaseTokens.map(name => resolve(name))

    expect(new Set(literals).size).toBe(phaseTokens.length)
  })

  test('the app bar is sticky above page content and below popovers', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    const barStart = style.indexOf('.app-bar')
    const barRule = style.slice(barStart, style.indexOf('}', barStart))
    expect(barRule).toContain('position: sticky')
    expect(barRule).toContain('top: 0')
    expect(barRule).toContain('z-index: var(--z-app-bar)')

    const pickerStart = style.indexOf('.loop-picker-menu')
    const pickerRule = style.slice(pickerStart, style.indexOf('}', pickerStart))
    expect(pickerRule).toContain('var(--z-popover)')

    const root = style.slice(style.indexOf(':root'), style.indexOf('}', style.indexOf(':root')))
    const resolved = new Map<string, string>()
    for (const match of root.matchAll(/--([a-zA-Z0-9-]+):\s*([^;]+);/g)) {
      resolved.set(`--${match[1]}`, match[2].trim())
    }
    const appBarZ = Number(resolved.get('--z-app-bar'))
    const popoverZ = Number(resolved.get('--z-popover'))
    expect(Number.isFinite(appBarZ)).toBe(true)
    expect(Number.isFinite(popoverZ)).toBe(true)
    expect(appBarZ).toBeLessThan(popoverZ)
  })

  test('no ancestor of the sticky app bar clips overflow', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    for (const sel of ['body', '.forge-app', '.forge-shell']) {
      const re = new RegExp(`(?:^|\\n)\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`)
      const match = re.exec(style)
      expect(match, `${sel} rule not found`).toBeTruthy()
      expect(match![1]).not.toContain('overflow')
    }
  })

  test('the section nav and tab bar stick directly beneath the app bar', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    for (const sel of ['.section-nav', '.tab-bar']) {
      const start = style.indexOf(sel)
      expect(start, `${sel} rule not found`).toBeGreaterThan(0)
      const rule = style.slice(start, style.indexOf('}', start))
      expect(rule).toContain('position: sticky')
      expect(rule).toContain('top: var(--app-bar-h)')
      expect(rule).toContain('z-index: var(--z-subnav)')
      expect(rule).toContain('background: var(--bg-0)')
    }

    const root = style.slice(style.indexOf(':root'), style.indexOf('}', style.indexOf(':root')))
    const resolved = new Map<string, string>()
    for (const match of root.matchAll(/--([a-zA-Z0-9-]+):\s*([^;]+);/g)) {
      resolved.set(`--${match[1]}`, match[2].trim())
    }
    const subnavZ = Number(resolved.get('--z-subnav'))
    const appBarZ = Number(resolved.get('--z-app-bar'))
    const popoverZ = Number(resolved.get('--z-popover'))
    expect(Number.isFinite(subnavZ)).toBe(true)
    expect(Number.isFinite(appBarZ)).toBe(true)
    expect(Number.isFinite(popoverZ)).toBe(true)
    expect(subnavZ).toBeLessThan(appBarZ)
    expect(appBarZ).toBeLessThan(popoverZ)

    // Any enclosing scroll container (overflow other than visible) would
    // pin the nested .tab-bar to that container instead of the viewport.
    for (const sel of ['.loop', '.loop-detail', '.repo-pane', '.forge-shell']) {
      const re = new RegExp(`(?:^|\\n)\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`)
      const match = re.exec(style)
      expect(match, `${sel} rule not found`).toBeTruthy()
      expect(match![1]).not.toContain('overflow')
    }
  })

  test('the load-error message is inset with the shell gutter', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    const start = style.indexOf('.error-text')
    const rule = style.slice(start, style.indexOf('}', start))
    expect(rule).toContain('padding: var(--sp-3) var(--sp-5)')
  })

  test('the loop table drops low-priority columns on narrow viewports', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    const media1100 = style.indexOf('@media (max-width: 1100px)')
    expect(media1100).toBeGreaterThan(0)
    const block1100 = style.slice(media1100, style.indexOf('}', media1100))
    for (const col of ['span', 'iter', 'sections']) {
      expect(block1100).toContain(`[data-col="${col}"]`)
    }
    expect(block1100).toContain('display: none')

    const media820 = style.indexOf('@media (max-width: 820px)')
    expect(media820).toBeGreaterThan(media1100)
    const block820 = style.slice(media820, style.indexOf('}', media820))
    expect(block820).toContain('[data-col="phase"]')
    expect(block820).toContain('[data-col="updated"]')
    expect(block820).toContain('display: none')
    // Columns that must always remain visible are never hidden at either breakpoint.
    for (const col of ['status', 'loop', 'findings', 'cost', 'duration']) {
      expect(style).not.toContain(`[data-col="${col}"] { display: none`)
    }
  })

  test('the loop table zebra striping keeps hover feedback and mono cells inherit the table size', () => {
    const html = renderDashboardHtml()
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

    // Equal-specificity zebra rules must precede hover so the hover state wins.
    const evenIdx = style.indexOf('.lt-row:nth-child(even)')
    const oddIdx = style.indexOf('.lt-row:nth-child(odd)')
    const hoverIdx = style.indexOf('.lt-row:hover')
    expect(evenIdx).toBeGreaterThan(0)
    expect(oddIdx).toBeGreaterThan(evenIdx)
    expect(hoverIdx).toBeGreaterThan(oddIdx)
    const hoverRule = style.slice(hoverIdx, style.indexOf('}', hoverIdx))
    expect(hoverRule).toContain('background: var(--hover)')
    expect(hoverRule).not.toContain('var(--bg-0)')
    expect(hoverRule).not.toContain('var(--panel)')

    // Body mono cells inherit var(--fs-sm) from .loop-table; no font-size literal.
    const monoIdx = style.indexOf('.lt-phase, .lt-cost, .lt-duration, .lt-updated, .lt-meter-text')
    expect(monoIdx).toBeGreaterThan(0)
    const monoRule = style.slice(monoIdx, style.indexOf('}', monoIdx))
    expect(monoRule).not.toContain('font-size')
  })
})
