import { MARKED_SOURCE } from './marked-source'
import { DASHBOARD_APP_BUNDLE } from './app-bundle'

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    padding: 16px;
  }
  h1 { font-size: 1.3rem; margin-bottom: 8px; color: #f0f6fc; }
  h2 { font-size: 1.2rem; margin-bottom: 6px; color: #f0f6fc; }
  .totals { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .totals .badge {
    padding: 4px 10px; border-radius: 12px; font-size: 0.8rem;
    background: #21262d; color: #c9d1d9;
  }
  .totals .badge-filter { cursor: pointer; user-select: none; }
  .totals .badge-filter:hover { background: #30363d; }
  .totals .badge-active { background: #1f6feb; color: #fff; }
  .search-input {
    width: 100%; max-width: 360px; margin-bottom: 16px;
    padding: 6px 10px; border-radius: 6px;
    border: 1px solid #30363d; background: #0d1117; color: #c9d1d9;
    font-size: 0.85rem;
  }
  .search-input::placeholder { color: #484f58; }
  .search-input:focus { outline: none; border-color: #1f6feb; }
  .dash-layout { display: flex; gap: 16px; align-items: flex-start; }
  .project-sidebar {
    flex: 0 0 260px; max-width: 260px;
    border: 1px solid #30363d; border-radius: 8px; background: #161b22;
    overflow: hidden; position: sticky; top: 20px;
  }
  .project-detail { flex: 1 1 auto; min-width: 0; }
  .project-nav-item {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer; user-select: none;
    border-bottom: 1px solid #21262d; font-size: 0.9rem; color: #c9d1d9;
  }
  .project-nav-item:last-child { border-bottom: none; }
  .project-nav-item:hover { background: #1c2128; }
  .project-nav-item.selected { background: #1f6feb22; border-left: 3px solid #1f6feb; padding-left: 9px; }
  .project-nav-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #58a6ff; font-weight: 600; }
  .project-nav-item.selected .project-nav-name { color: #79c0ff; }
  .project-nav-count { font-size: 0.7rem; padding: 1px 7px; border-radius: 9px; background: #30363d; color: #c9d1d9; }
  .project-nav-running { width: 8px; height: 8px; border-radius: 50%; background: #fe7d37; flex: 0 0 8px; box-shadow: 0 0 6px #fe7d3780; }
  .project { margin-bottom: 24px; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; background: #161b22; }
  .project-header { font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; color: #58a6ff; }
  .empty-state { padding: 24px; color: #8b949e; font-size: 0.9rem; text-align: center; }
  .loop {
    border: 1px solid #30363d; border-radius: 6px; margin-bottom: 8px;
    background: #0d1117; overflow: hidden;
  }
  .status-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
  }
  .status-running { background: #1f6feb; color: #fff; }
  .status-completed { background: #238636; color: #fff; }
  .status-cancelled { background: #6e7681; color: #fff; }
  .status-errored { background: #da3633; color: #fff; }
  .status-stalled { background: #d29922; color: #fff; }
  .loop-detail { padding: 8px 12px 12px; border-top: 1px solid #30363d; font-size: 0.85rem; }
  .loop-detail h4 { color: #f0f6fc; margin: 8px 0 4px; font-size: 0.95rem; }
  .loop-detail h4:first-child { margin-top: 0; }
  .section-item-pending { border-left-color: #6e7681; }
  .section-item-in_progress { border-left-color: #1f6feb; }
  .section-item-completed { border-left-color: #3fb950; }
  .section-item-failed { border-left-color: #f85149; }
  .section-caret { color: #8b949e; font-size: 0.7rem; width: 10px; flex-shrink: 0; }
  .section-status {
    font-size: 0.66rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; flex-shrink: 0;
  }
  .section-pending { color: #8b949e; }
  .section-in_progress { color: #58a6ff; }
  .section-completed { color: #3fb950; }
  .section-failed { color: #f85149; }
  .section-index { color: #8b949e; font-weight: 600; flex-shrink: 0; }
  .section-title {
    color: #c9d1d9; flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .section-duration { color: #8b949e; font-size: 0.75rem; flex-shrink: 0; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .section-attempts { color: #d29922; font-size: 0.72rem; flex-shrink: 0; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .sections-panel { display: flex; flex-direction: column; gap: 8px; }
  .section-list { display: flex; flex-direction: column; gap: 6px; }
  .section-list-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer;
    border: 1px solid #21262d; border-left: 3px solid #30363d; border-radius: 4px; background: #0d1117; }
  .section-list-row:hover { background: #161b22; }
  .back-to-sections { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    color: #58a6ff; font-size: 0.85rem; margin-bottom: 10px; user-select: none; }
  .back-to-sections:hover { color: #79c0ff; }
  .section-drill-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .section-body {
    padding: 10px 12px 12px; border-top: 1px solid #21262d;
    display: flex; flex-direction: column; gap: 10px;
  }
  .section-timing { font-size: 0.78rem; color: #8b949e; }
  .section-summary-part { display: flex; flex-direction: column; gap: 3px; }
  .section-summary-label {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e;
  }
  .section-empty { font-size: 0.8rem; color: #484f58; font-style: italic; }
  .finding { padding: 2px 0; }
  .finding-bug { color: #f85149; }
  .finding-warning { color: #d29922; }
  .usage-row { padding: 2px 0; color: #8b949e; }
  .usage-group { display: flex; flex-direction: column; gap: 12px; }
  .usage-block {
    border: 1px solid #21262d; border-radius: 6px; padding: 10px 12px; background: #0d1117;
  }
  .usage-block-title {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: #8b949e; margin-bottom: 8px;
  }
  .usage-stack {
    display: flex; height: 12px; border-radius: 4px; overflow: hidden;
    background: #21262d; margin-bottom: 10px;
  }
  .usage-stack-seg { height: 100%; min-width: 2px; transition: width 0.3s ease; }
  .usage-stack-seg:not(:last-child) { border-right: 1px solid #0d1117; }
  .usage-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .usage-legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.76rem; }
  .usage-legend-dot { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 9px; }
  .usage-legend-label { color: #8b949e; }
  .usage-legend-value { color: #f0f6fc; font-weight: 600; }
  .usage-models { display: flex; flex-direction: column; gap: 10px; }
  .usage-model-row { display: flex; flex-direction: column; gap: 4px; }
  .usage-model-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .usage-model-name {
    color: #c9d1d9; font-size: 0.82rem; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .usage-model-cost { color: #3fb950; font-weight: 600; font-size: 0.82rem; flex-shrink: 0; }
  .usage-model-track { height: 6px; border-radius: 4px; background: #21262d; overflow: hidden; }
  .usage-model-fill { height: 100%; border-radius: 4px; background: #1f6feb; transition: width 0.3s ease; }
  .usage-model-meta { font-size: 0.72rem; color: #8b949e; }
  .timestamp { font-size: 0.75rem; color: #484f58; margin-bottom: 12px; }
  .error-text { color: #f85149; }
  .dim { color: #484f58; }
  .resizable-block {
    resize: vertical; overflow: auto;
    min-height: 0; height: auto; max-height: 60vh;
    border: 1px solid #30363d; border-radius: 4px;
    background: #0d1117; padding: 8px; margin-top: 4px;
  }
  .markdown-content { font-size: 0.85rem; line-height: 1.6; color: #c9d1d9; }
  .markdown-content h1 { font-size: 1.3rem; margin: 16px 0 8px; color: #f0f6fc; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
  .markdown-content h2 { font-size: 1.15rem; margin: 14px 0 6px; color: #f0f6fc; border-bottom: 1px solid #21262d; padding-bottom: 3px; }
  .markdown-content h3 { font-size: 1.05rem; margin: 12px 0 5px; color: #f0f6fc; }
  .markdown-content h4 { font-size: 0.95rem; margin: 10px 0 4px; color: #f0f6fc; }
  .markdown-content p { margin: 6px 0; }
  .markdown-content ul, .markdown-content ol { margin: 4px 0; padding-left: 20px; }
  .markdown-content li { margin: 2px 0; }
  .markdown-content code {
    background: #21262d; border-radius: 3px; padding: 1px 5px;
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
    font-size: 0.78rem; color: #f0f6fc;
  }
  .markdown-content pre {
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 12px; overflow-x: auto; margin: 8px 0;
  }
  .markdown-content pre code {
    background: none; padding: 0; border-radius: 0;
    font-size: 0.78rem; color: #c9d1d9; line-height: 1.5;
  }
  .markdown-content blockquote {
    border-left: 3px solid #30363d; padding-left: 12px; margin: 8px 0;
    color: #8b949e;
  }
  .markdown-content table { border-collapse: collapse; margin: 8px 0; font-size: 0.8rem; }
  .markdown-content th, .markdown-content td {
    border: 1px solid #30363d; padding: 4px 8px; text-align: left;
  }
  .markdown-content th { background: #161b22; color: #f0f6fc; font-weight: 600; }
  .markdown-content hr { border: none; border-top: 1px solid #30363d; margin: 12px 0; }
  .markdown-content strong { color: #f0f6fc; }
  .markdown-content a { color: #58a6ff; text-decoration: none; }
  .markdown-content a:hover { text-decoration: underline; }
  .markdown-content img { max-width: 100%; border-radius: 4px; }
  .loop-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .loop-table th { text-align: left; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: #8b949e; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid #30363d; white-space: nowrap; }
  .loop-table td { padding: 7px 10px; border-bottom: 1px solid #21262d; vertical-align: middle; }
  .lt-row { cursor: pointer; }
  .lt-row:hover { background: #161b22; }
  .lt-name { color: #58a6ff; font-weight: 600; }
  .lt-phase, .lt-cost, .lt-duration, .lt-updated, .lt-meter-text {
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; font-size: 0.76rem; color: #8b949e; }
  .lt-cost { color: #3fb950; }
  .lt-meter-cell { display: inline-flex; align-items: center; gap: 6px; }
  .lt-meter { width: 46px; height: 5px; border-radius: 3px; background: #21262d; overflow: hidden; flex: 0 0 46px; }
  .lt-meter-fill { display: block; height: 100%; background: #1f6feb; }
  .back-to-loops {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    color: #58a6ff; font-size: 0.85rem; margin-bottom: 12px; user-select: none;
  }
  .back-to-loops:hover { color: #79c0ff; }
  .loop-detail-header {
    display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 16px; padding: 16px;
    border: 1px solid #30363d; border-radius: 8px; background: #161b22;
  }
  .ldh-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ldh-name { font-size: 1.15rem; font-weight: 600; color: #f0f6fc; margin: 0; word-break: break-word; }
  .ldh-phase {
    margin-left: auto; font-size: 0.7rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: #d29922; background: rgba(210, 153, 34, 0.12);
    border: 1px solid rgba(210, 153, 34, 0.3);
    padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  }
  .ldh-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px;
  }
  .ldh-stat {
    display: flex; flex-direction: column; gap: 3px;
    padding: 6px 8px; border-radius: 6px;
    background: #0d1117; border: 1px solid #21262d;
  }
  .ldh-stat-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; }
  .ldh-stat-value { font-size: 0.9rem; color: #f0f6fc; font-weight: 600; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .ldh-bars { display: flex; flex-direction: column; gap: 10px; }
  .ldh-bar-group { display: flex; flex-direction: column; gap: 4px; }
  .ldh-bar-head { display: flex; justify-content: space-between; align-items: baseline; }
  .ldh-bar-label { color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.66rem; }
  .ldh-bar-count { color: #c9d1d9; font-weight: 600; font-size: 0.78rem; }
  .ldh-bar-track { height: 6px; border-radius: 4px; background: #21262d; overflow: hidden; }
  .ldh-bar-fill { height: 100%; border-radius: 4px; background: #1f6feb; transition: width 0.3s ease; }
  .ldh-banner {
    font-size: 0.82rem; padding: 8px 12px; border-radius: 6px;
    border: 1px solid #30363d; color: #c9d1d9;
  }
  .ldh-banner-completed { background: rgba(35, 134, 54, 0.12); border-color: rgba(35, 134, 54, 0.4); color: #3fb950; }
  .ldh-banner-errored { background: rgba(218, 54, 51, 0.12); border-color: rgba(218, 54, 51, 0.4); color: #f85149; }
  .ldh-banner-cancelled { background: rgba(110, 118, 129, 0.15); border-color: #6e7681; color: #8b949e; }
  .ldh-banner-stalled { background: rgba(210, 153, 34, 0.12); border-color: rgba(210, 153, 34, 0.4); color: #d29922; }
  .ldh-banner-running { background: rgba(31, 111, 235, 0.12); border-color: rgba(31, 111, 235, 0.4); color: #58a6ff; }
  .ldh-findings { font-size: 0.78rem; font-weight: 600; padding: 6px 12px; border-radius: 6px;
    border: 1px solid #30363d; align-self: flex-start; }
  .ldh-findings-bug { background: rgba(248,81,73,0.12); border-color: rgba(248,81,73,0.4); color: #f85149; }
  .ldh-findings-warn { background: rgba(210,153,34,0.12); border-color: rgba(210,153,34,0.4); color: #d29922; }
  .ldh-findings-clean { background: rgba(63,185,80,0.10); border-color: rgba(63,185,80,0.3); color: #3fb950; }
  .markdown-scrollable {
    max-height: 320px; overflow-y: auto;
    border: 1px solid #30363d; border-radius: 6px;
    padding: 8px 12px; margin-top: 4px;
  }
  .loop-detail .section-label { color: #d29922; }
  .markdown-heading-row {
    display: flex; align-items: center; gap: 8px; margin: 8px 0 4px;
  }
  .markdown-heading-row:first-child { margin-top: 0; }
  .markdown-heading-row h4 { margin: 0; }
  .copy-btn {
    background: #21262d; color: #8b949e; border: 1px solid #30363d;
    border-radius: 4px; padding: 1px 8px; font-size: 0.72rem;
    cursor: pointer; user-select: none; line-height: 1.5;
    font-family: inherit; flex-shrink: 0;
  }
  .copy-btn:hover { background: #30363d; color: #c9d1d9; }
  .dashboard-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
  .dashboard-summary .totals { margin: 0; }
  .dashboard-summary .timestamp { margin: 0; }
  .metrics-nav-link {
    display: inline-block; padding: 4px 12px; border-radius: 12px;
    font-size: 0.8rem; cursor: pointer; user-select: none;
    background: #21262d; color: #58a6ff; border: 1px solid #30363d;
    margin-left: auto;
  }
  .metrics-nav-link:hover { background: #30363d; }
  .metrics-nav-link.selected { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .metrics-layout .project-detail { padding: 0; }
  .loop-metrics-panel {
    display: flex; flex-direction: column; gap: 10px;
    margin-top: 12px; padding: 12px 14px;
    border: 1px solid #30363d; border-radius: 8px; background: #161b22;
  }
  .loop-metrics-panel h4 {
    color: #f0f6fc; margin: 0 0 4px; font-size: 0.95rem;
  }
  .metrics-blocks {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    border: 1px solid #21262d; border-radius: 7px; overflow: hidden; background: #0d1117;
  }
  .metrics-block {
    min-width: 0; border: 1px solid #21262d; border-radius: 6px; padding: 12px 14px;
    background: #0d1117;
  }
  .metrics-blocks > .metrics-block { border: 0; border-radius: 0; padding: 14px 16px; }
  .metrics-blocks > .metrics-block:nth-child(even) { border-right: 1px solid #21262d; }
  .metrics-blocks > .metrics-block:not(:last-child) { border-bottom: 1px solid #21262d; }
  .metrics-block-wide { grid-column: 1 / -1; }
  .metrics-block-title {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: #8b949e; margin-bottom: 8px; font-weight: 600;
  }
  .metrics-block-legend {
    font-size: 0.72rem; color: #9da7b3; margin-bottom: 10px;
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  }
  .metrics-legend-swatch {
    display: inline-block; width: 9px; height: 9px; border-radius: 2px;
    flex: 0 0 9px; margin-left: 5px;
  }
  .metrics-token-legend .metrics-legend-swatch:first-child { margin-left: 0; }
  .metrics-empty {
    font-size: 0.82rem; color: #8b949e; font-style: italic; padding: 6px 0;
  }
  .forge-chart { width: 100%; min-width: 0; overflow-x: auto; }
  .forge-chart-plot {
    width: 100%; min-height: 154px; display: flex; align-items: stretch; gap: 10px;
    padding: 4px 6px 0; border-bottom: 1px solid #30363d;
    background: repeating-linear-gradient(to top, transparent 0, transparent 37px, rgba(48,54,61,0.46) 38px);
  }
  .forge-chart-column {
    flex: 1 1 0; min-width: 38px; display: grid; grid-template-rows: 20px 108px 24px;
    align-items: end; text-align: center;
  }
  .forge-chart-value {
    align-self: start; color: #c9d1d9; font-size: 0.68rem; line-height: 1;
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; white-space: nowrap;
  }
  .forge-chart-bar-slot { height: 108px; display: flex; align-items: flex-end; justify-content: center; }
  .forge-chart-bar {
    width: clamp(12px, 62%, 54px); height: 100%; display: flex; flex-direction: column-reverse;
    justify-content: flex-start; overflow: hidden; border-radius: 4px 4px 0 0;
  }
  .forge-chart-segment { width: 100%; flex: 0 0 auto; transition: height 180ms cubic-bezier(0.25, 1, 0.5, 1); }
  .forge-chart-segment + .forge-chart-segment { box-shadow: inset 0 -1px rgba(13,17,23,0.55); }
  .forge-chart-label {
    align-self: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
    color: #8b949e; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace;
    font-size: 0.7rem; white-space: nowrap;
  }
  .forge-chart-empty {
    min-height: 132px; display: grid; place-items: center; padding: 18px;
    border: 1px dashed #30363d; border-radius: 5px;
    font-size: 0.78rem; color: #8b949e; text-align: center;
  }
  .forge-audit-timeline {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(86px, 1fr);
    overflow-x: auto; padding: 10px 2px 4px;
  }
  .forge-audit-step {
    position: relative; min-width: 86px; display: flex; flex-direction: column;
    align-items: flex-start; cursor: help;
  }
  .forge-audit-step:not(:last-child)::after {
    content: ''; position: absolute; z-index: 0; top: 6px; left: 13px; right: 0;
    height: 1px; background: #30363d;
  }
  .forge-audit-marker {
    position: relative; z-index: 1; width: 13px; height: 13px; border-radius: 50%;
    border: 3px solid #0d1117; box-shadow: 0 0 0 1px currentColor; background: currentColor;
  }
  .forge-audit-iteration {
    margin-top: 10px; color: #8b949e; font-size: 0.68rem;
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; white-space: nowrap;
  }
  .forge-audit-verdict { margin-top: 2px; font-size: 0.76rem; font-weight: 600; }
  .forge-audit-clean { color: #3fb950; }
  .forge-audit-dirty { color: #f85149; }
  .forge-audit-unknown { color: #8b949e; }
  .runs-view {
    border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px;
    background: #161b22; display: flex; flex-direction: column; gap: 12px;
  }
  .runs-view h2 { color: #f0f6fc; }
  .runs-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .runs-table th {
    text-align: left; font-size: 0.66rem; text-transform: uppercase;
    letter-spacing: 0.05em; color: #8b949e; font-weight: 600;
    padding: 6px 8px; border-bottom: 1px solid #30363d; white-space: nowrap;
  }
  .runs-table td { padding: 6px 8px; border-bottom: 1px solid #21262d; vertical-align: middle; }
  .runs-row:hover { background: #161b22; }
  .runs-loop { color: #58a6ff; font-weight: 600; }
  .runs-models, .runs-num, .runs-duration, .runs-updated {
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; font-size: 0.74rem; color: #8b949e;
  }
  .runs-cost { color: #3fb950; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; font-size: 0.74rem; }
  @media (max-width: 900px) {
    .metrics-blocks { grid-template-columns: minmax(0, 1fr); }
    .metrics-block-wide { grid-column: auto; }
    .metrics-blocks > .metrics-block:nth-child(even) { border-right: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .forge-chart-segment { transition: none; }
  }</style>
</head>
<body>
  <div id="forge-app-root"></div>
  <script>${MARKED_SOURCE}</script>
  <script type="module">${DASHBOARD_APP_BUNDLE}</script>
</body>
</html>`
}
