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
    padding: 20px;
  }
  h1 { font-size: 1.5rem; margin-bottom: 8px; color: #f0f6fc; }
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
  .loop-info { font-size: 0.85rem; color: #8b949e; flex: 1; }
  .loop-info strong { color: #c9d1d9; }
  .loop-detail { padding: 8px 12px 12px; border-top: 1px solid #30363d; font-size: 0.85rem; }
  .loop-detail h4 { color: #f0f6fc; margin: 8px 0 4px; font-size: 0.95rem; }
  .loop-detail h4:first-child { margin-top: 0; }
  .section-row { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
  .section-status { font-size: 0.7rem; padding: 1px 6px; border-radius: 8px; }
  .section-pending { background: #21262d; color: #8b949e; }
  .section-in_progress { background: #1f6feb; color: #fff; }
  .section-completed { background: #238636; color: #fff; }
  .section-failed { background: #da3633; color: #fff; }
  .finding { padding: 2px 0; }
  .finding-bug { color: #f85149; }
  .finding-warning { color: #d29922; }
  .usage-row { padding: 2px 0; color: #8b949e; }
  .timestamp { font-size: 0.75rem; color: #484f58; margin-bottom: 12px; }
  .error-text { color: #f85149; }
  .dim { color: #484f58; }
  .resizable-block {
    resize: both; overflow: auto;
    min-height: 120px; height: 60vh; max-height: none;
    border: 1px solid #30363d; border-radius: 4px;
    background: #0d1117; padding: 8px; margin-top: 4px;
  }
  pre.resizable-block { white-space: pre-wrap; word-break: break-word; font-size: 0.78rem; color: #8b949e; }
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
  .loop-row {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    cursor: pointer; user-select: none; border: 1px solid #30363d;
    border-radius: 6px; margin-bottom: 8px; background: #0d1117;
  }
  .loop-row:hover { background: #161b22; }
  .back-to-loops {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    color: #58a6ff; font-size: 0.85rem; margin-bottom: 12px; user-select: none;
  }
  .back-to-loops:hover { color: #79c0ff; }
  .loop-detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
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
  .copy-btn:hover { background: #30363d; color: #c9d1d9; }</style>
</head>
<body>
  <div id="forge-app-root"></div>
  <script>${MARKED_SOURCE}</script>
  <script type="module">${DASHBOARD_APP_BUNDLE}</script>
</body>
</html>`
}
