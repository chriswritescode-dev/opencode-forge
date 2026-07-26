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
  :root {
    --bg-0:#0d1117; --bg-1:#11161d; --bg-2:#171b22; --bg-3:#1e242d;
    --border:#262c36; --border-strong:#333b47;
    --fg-0:#c9d1d9; --fg-1:#9aa6b4; --fg-2:#6b7684;
    --running:#d29922; --ok:#3fb950; --errored:#f85149;
    --warning:#fe7d37; --cancelled:#8b949e; --stalled:#a371f7;
    --accent:#4c8dff;
    --ph-coding:#1f6feb; --ph-auditing:#a371f7;
    --ph-final-auditing:#d29922; --ph-final-audit-fix:#fe7d37;
    --ph-post-action:#3fb950;
    --seg-input:#1f6feb; --seg-output:#3fb950; --seg-reasoning:#a371f7;
    --seg-cache-read:#d29922; --seg-cache-write:#db61a2;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --r-1:3px; --r-2:6px; --r-3:10px;
    --fg-bright:#f0f6fc; --fg-dim:#484f58;
    --surface:#21262d; --panel:#161b22; --hover:#1c2128;
    --divider:#30363d; --link:#58a6ff; --link-hover:#79c0ff;
    --ok-bg:#238636; --neutral:#6e7681; --errored-bg:#da3633;
    --edge-label:#f5c518;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg-0);
    color: var(--fg-0);
    padding: 16px;
  }
  h1 { font-size: 1.3rem; margin-bottom: 8px; color: var(--fg-bright); }
  h2 { font-size: 1.2rem; margin-bottom: 6px; color: var(--fg-bright); }
  .filter-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 8px 10px; border: 1px solid var(--divider); border-radius: 6px;
    background: var(--panel);
  }
  .filter-bar .badge {
    padding: 4px 10px; border-radius: 12px; font-size: 0.8rem;
    background: var(--surface); color: var(--fg-0);
  }
  .filter-bar .badge-filter { cursor: pointer; user-select: none; }
  .filter-bar .badge-filter:hover { background: var(--divider); }
  .filter-bar .badge-active { background: var(--ph-coding); color: #fff; }
  .filter-bar .search-input { margin: 0; max-width: 240px; }
  .sort-select {
    margin-left: auto; padding: 4px 8px; border-radius: 6px;
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-size: 0.8rem; font-family: inherit; cursor: pointer;
  }
  .sort-select:focus { outline: none; border-color: var(--ph-coding); }
  .search-input {
    width: 100%; max-width: 360px; margin-bottom: 16px;
    padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-size: 0.85rem;
  }
  .search-input::placeholder { color: var(--fg-dim); }
  .search-input:focus { outline: none; border-color: var(--ph-coding); }
  .forge-shell { display: flex; flex-direction: column; gap: 12px; }
  .repo-index { display: flex; gap: 16px; align-items: flex-start; }
  .repo-index .repo-menu { flex: 0 0 280px; }
  .repo-index-pane { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .repo-index-head { display: flex; flex-direction: column; gap: 4px; }
  .repo-index-summary { color: var(--fg-1); font-size: 0.85rem; }
  .repo-index-section { display: flex; flex-direction: column; gap: 6px; }
  .repo-index-section-title {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--cancelled); font-weight: 600;
  }
  .repo-running-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .repo-running-card {
    display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
    padding: 8px 12px; border: 1px solid var(--divider); border-radius: 6px;
    background: var(--panel); font-size: 0.82rem;
  }
  .repo-running-card:hover { background: var(--hover); }
  .repo-running-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--warning);
    flex: 0 0 8px; box-shadow: 0 0 6px var(--warning);
  }
  .repo-running-label { color: var(--link); font-weight: 600; }
  .repo-running-name { color: var(--fg-bright); }
  .repo-running-phase {
    margin-left: auto; color: var(--fg-2); font-family: var(--mono);
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .repo-recent-list { display: flex; flex-direction: column; gap: 2px; }
  .repo-recent-row {
    display: grid; grid-template-columns: 110px 140px 1fr auto; align-items: baseline;
    gap: 10px; padding: 6px 10px; cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0); font-size: 0.82rem;
  }
  .repo-recent-row:hover { background: var(--panel); }
  .repo-recent-label { color: var(--link); font-weight: 600; }
  .repo-recent-name { color: var(--fg-bright); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-recent-when { color: var(--fg-2); font-family: var(--mono); font-size: 0.74rem; }
  .repo-menu {
    display: flex; flex-direction: column; gap: 1px;
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
    overflow: hidden;
  }
  .repo-menu-item {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer; user-select: none;
    border-bottom: 1px solid var(--surface); font-size: 0.9rem; color: var(--fg-0);
  }
  .repo-menu-item:last-child { border-bottom: none; }
  .repo-menu-item:hover { background: var(--hover); }
  .repo-menu-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--link); font-weight: 600;
  }
  .repo-menu-count {
    font-size: 0.7rem; padding: 1px 7px; border-radius: 9px;
    background: var(--divider); color: var(--fg-0);
  }
  .repo-menu-running {
    width: 8px; height: 8px; border-radius: 50%; background: var(--warning);
    flex: 0 0 8px; box-shadow: 0 0 6px var(--warning);
  }
  .repo-pane { display: flex; flex-direction: column; gap: 12px; }
  .breadcrumb {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border: 1px solid var(--divider); border-radius: 6px;
    background: var(--panel); font-size: 0.9rem;
  }
  .breadcrumb-back { color: var(--link); cursor: pointer; user-select: none; }
  .breadcrumb-back:hover { color: var(--link-hover); }
  .breadcrumb-sep { color: var(--fg-dim); }
  .breadcrumb-label { color: var(--fg-bright); font-weight: 600; }
  .loop-picker { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .breadcrumb-loop {
    padding: 3px 6px; border-radius: var(--r-1);
    border: 1px solid transparent; background: transparent; cursor: pointer;
    color: var(--fg-bright); font-weight: 600; font-family: inherit; font-size: inherit;
    text-overflow: ellipsis;
  }
  .breadcrumb-loop:hover { background: var(--hover); border-color: var(--divider); }
  .breadcrumb-loop:focus { outline: none; cursor: text; background: var(--bg-0); border-color: var(--ph-coding); }
  .breadcrumb-loop::placeholder { color: var(--fg-bright); opacity: 1; }
  .loop-picker-caret { color: var(--fg-2); font-size: 0.7rem; cursor: pointer; user-select: none; }
  .loop-picker-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 20;
    min-width: 340px; max-height: 320px; overflow-y: auto; padding: 4px;
    border: 1px solid var(--divider); border-radius: var(--r-2);
    background: var(--panel); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  }
  .loop-picker-option {
    display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
    padding: 5px 8px; border-radius: var(--r-1); cursor: pointer; font-size: 0.82rem;
  }
  .loop-picker-option:hover { background: var(--surface); }
  .loop-picker-option-active { background: var(--hover); }
  .loop-picker-option-name {
    color: var(--fg-0); min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .loop-picker-option-current .loop-picker-option-name { color: var(--link); font-weight: 600; }
  .loop-picker-option-when { color: var(--fg-2); font-family: var(--mono); font-size: 0.72rem; white-space: nowrap; }
  .loop-picker-empty { padding: 6px 8px; color: var(--fg-2); font-size: 0.8rem; }
  .breadcrumb-path {
    margin-left: auto; color: var(--fg-2); font-family: var(--mono);
    font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .breadcrumb-loopnav {
    display: inline-flex; align-items: center; gap: 4px; margin-left: 10px;
    color: var(--fg-2); font-size: 0.8rem; user-select: none;
  }
  .loopnav-prev, .loopnav-next {
    cursor: pointer; padding: 1px 6px; border-radius: 4px;
    color: var(--link); font-weight: 600;
  }
  .loopnav-prev:hover, .loopnav-next:hover { background: var(--hover); color: var(--link-hover); }
  .loopnav-count { font-family: var(--mono); font-size: 0.76rem; color: var(--fg-1); }
  .section-nav {
    display: flex; gap: 4px; border-bottom: 1px solid var(--divider);
  }
  .section-nav-item {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px; cursor: pointer; user-select: none;
    color: var(--fg-1); font-size: 0.85rem; border-bottom: 2px solid transparent;
  }
  .section-nav-item:hover { color: var(--fg-0); background: var(--hover); }
  .section-nav-active {
    color: var(--fg-bright); font-weight: 600;
    border-bottom: 2px solid var(--accent);
  }
  .section-nav-count {
    font-size: 0.7rem; padding: 1px 7px; border-radius: 9px;
    background: var(--divider); color: var(--fg-0);
  }
  .empty-state { padding: 24px; color: var(--cancelled); font-size: 0.9rem; text-align: center; }
  .loop {
    border: 1px solid var(--divider); border-radius: 6px; margin-bottom: 8px;
    background: var(--bg-0); overflow: hidden;
  }
  .status-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
  }
  .status-running { background: var(--ph-coding); color: #fff; }
  .status-completed { background: var(--ok-bg); color: #fff; }
  .status-cancelled { background: var(--neutral); color: #fff; }
  .status-errored { background: var(--errored-bg); color: #fff; }
  .status-stalled { background: var(--running); color: #fff; }
  .status-extracting { background: var(--link); color: #fff; }
  .status-planning { background: var(--link); color: #fff; }
  .status-interrupted { background: var(--running); color: #fff; }
  .loop-detail { padding: 8px 12px 12px; border-top: 1px solid var(--divider); font-size: 0.85rem; }
  .loop-detail h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: 0.95rem; }
  .loop-detail h4:first-child { margin-top: 0; }
  .tab-bar {
    display: flex; flex-wrap: wrap; gap: 2px;
    border-bottom: 1px solid var(--divider); margin-bottom: 8px;
  }
  .tab-item {
    padding: 6px 12px; cursor: pointer; user-select: none;
    color: var(--fg-1); font-size: 0.82rem; border-bottom: 2px solid transparent;
  }
  .tab-item:hover { color: var(--fg-0); background: var(--hover); }
  .tab-active { color: var(--fg-bright); font-weight: 600; border-bottom: 2px solid var(--accent); }
  .tab-body { padding: 4px 0 8px; }
  .tab-empty { padding: 16px 8px; color: var(--fg-dim); font-style: italic; }
  .findings-tab { display: flex; flex-direction: column; gap: 12px; }
  .findings-group { display: flex; flex-direction: column; gap: 6px; }
  .findings-group-label {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--accent); font-weight: 600;
  }
  .finding-time {
    color: var(--fg-dim); font-family: var(--mono); font-size: 0.72rem;
    flex: 0 0 auto; margin-right: 8px;
  }
  .finding-text { flex: 1 1 auto; min-width: 0; }
  .section-item-pending { border-left-color: var(--neutral); }
  .section-item-in_progress { border-left-color: var(--ph-coding); }
  .section-item-completed { border-left-color: var(--ok); }
  .section-item-failed { border-left-color: var(--errored); }
  .section-caret { color: var(--cancelled); font-size: 0.7rem; width: 10px; flex-shrink: 0; }
  .section-status {
    font-size: 0.66rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; flex-shrink: 0;
  }
  .section-pending { color: var(--cancelled); }
  .section-in_progress { color: var(--link); }
  .section-completed { color: var(--ok); }
  .section-failed { color: var(--errored); }
  .section-index { color: var(--cancelled); font-weight: 600; flex-shrink: 0; }
  .section-title {
    color: var(--fg-0); flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .section-duration { color: var(--cancelled); font-size: 0.75rem; flex-shrink: 0; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .section-attempts { color: var(--running); font-size: 0.72rem; flex-shrink: 0; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .sections-panel { display: flex; flex-direction: column; gap: 8px; }
  .section-list { display: flex; flex-direction: column; gap: 6px; }
  .section-list-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer;
    border: 1px solid var(--surface); border-left: 3px solid var(--divider); border-radius: 4px; background: var(--bg-0); }
  .section-list-row:hover { background: var(--panel); }
  .back-to-sections { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    color: var(--link); font-size: 0.85rem; margin-bottom: 10px; user-select: none; }
  .back-to-sections:hover { color: var(--link-hover); }
  .section-drill-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .section-body {
    padding: 10px 12px 12px; border-top: 1px solid var(--surface);
    display: flex; flex-direction: column; gap: 10px;
  }
  .section-timing { font-size: 0.78rem; color: var(--cancelled); }
  .section-summary-part { display: flex; flex-direction: column; gap: 3px; }
  .section-summary-label {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cancelled);
  }
  .section-empty { font-size: 0.8rem; color: var(--fg-dim); font-style: italic; }
  .finding { padding: 2px 0; display: flex; align-items: baseline; gap: 4px; }
  .finding-bug { color: var(--errored); }
  .finding-warning { color: var(--running); }
  .usage-group { display: flex; flex-direction: column; gap: 12px; }
  .usage-block {
    border: 1px solid var(--surface); border-radius: 6px; padding: 10px 12px; background: var(--bg-0);
  }
  .usage-block-title {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--cancelled); margin-bottom: 8px;
  }
  .usage-stack {
    display: flex; height: 12px; border-radius: 4px; overflow: hidden;
    background: var(--surface); margin-bottom: 10px;
  }
  .usage-stack-seg { height: 100%; min-width: 2px; transition: width 0.3s ease; }
  .usage-stack-seg:not(:last-child) { border-right: 1px solid var(--bg-0); }
  .usage-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .usage-legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.76rem; }
  .usage-legend-dot { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 9px; }
  .usage-legend-label { color: var(--cancelled); }
  .usage-legend-value { color: var(--fg-bright); font-weight: 600; }
  .usage-models { display: flex; flex-direction: column; gap: 10px; }
  .usage-model-row { display: flex; flex-direction: column; gap: 4px; }
  .usage-model-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .usage-model-name {
    color: var(--fg-0); font-size: 0.82rem; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .usage-model-cost { color: var(--ok); font-weight: 600; font-size: 0.82rem; flex-shrink: 0; }
  .usage-model-track { height: 6px; border-radius: 4px; background: var(--surface); overflow: hidden; }
  .usage-model-fill { height: 100%; border-radius: 4px; background: var(--ph-coding); transition: width 0.3s ease; }
  .usage-model-meta { font-size: 0.72rem; color: var(--cancelled); }
  .timestamp { font-size: 0.75rem; color: var(--fg-dim); margin-bottom: 12px; }
  .error-text { color: var(--errored); }
  .dim { color: var(--fg-dim); }
  .resizable-block {
    resize: vertical; overflow: auto;
    min-height: 0; height: auto; max-height: 60vh;
    border: 1px solid var(--divider); border-radius: 4px;
    background: var(--bg-0); padding: 8px; margin-top: 4px;
  }
  .markdown-content { font-size: 0.85rem; line-height: 1.6; color: var(--fg-0); }
  .markdown-content h1 { font-size: 1.3rem; margin: 16px 0 8px; color: var(--accent); border-bottom: 1px solid var(--divider); padding-bottom: 4px; }
  .markdown-content h2 { font-size: 1.15rem; margin: 14px 0 6px; color: var(--accent); border-bottom: 1px solid var(--surface); padding-bottom: 3px; }
  .markdown-content h3 { font-size: 1.05rem; margin: 12px 0 5px; color: var(--accent); }
  .markdown-content h4 { font-size: 0.95rem; margin: 10px 0 4px; color: var(--accent); }
  .markdown-content p { margin: 6px 0; }
  .markdown-content ul, .markdown-content ol { margin: 4px 0; padding-left: 20px; }
  .markdown-content li { margin: 2px 0; }
  .markdown-content code {
    background: var(--surface); border-radius: 3px; padding: 1px 5px;
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
    font-size: 0.78rem; color: var(--fg-bright);
  }
  .markdown-content pre {
    background: var(--panel); border: 1px solid var(--divider); border-radius: 6px;
    padding: 12px; overflow-x: auto; margin: 8px 0;
  }
  .markdown-content pre code {
    background: none; padding: 0; border-radius: 0;
    font-size: 0.78rem; color: var(--fg-0); line-height: 1.5;
  }
  .markdown-content blockquote {
    border-left: 3px solid var(--divider); padding-left: 12px; margin: 8px 0;
    color: var(--cancelled);
  }
  .markdown-content table { border-collapse: collapse; margin: 8px 0; font-size: 0.8rem; }
  .markdown-content th, .markdown-content td {
    border: 1px solid var(--divider); padding: 4px 8px; text-align: left;
  }
  .markdown-content th { background: var(--panel); color: var(--fg-bright); font-weight: 600; }
  .markdown-content hr { border: none; border-top: 1px solid var(--divider); margin: 12px 0; }
  .markdown-content strong { color: var(--fg-bright); }
  .markdown-content a { color: var(--link); text-decoration: none; }
  .markdown-content a:hover { text-decoration: underline; }
  .markdown-content img { max-width: 100%; border-radius: 4px; }
  .loop-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .loop-table th { text-align: left; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--cancelled); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--divider); white-space: nowrap; }
  .loop-table td { padding: 7px 10px; border-bottom: 1px solid var(--surface); vertical-align: middle; }
  .lt-row { cursor: pointer; }
  .lt-row:hover { background: var(--panel); }
  .lt-name { color: var(--link); font-weight: 600; }
  .lt-phase, .lt-cost, .lt-duration, .lt-updated, .lt-meter-text {
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; font-size: 0.76rem; color: var(--cancelled); }
  .lt-cost { color: var(--ok); }
  .lt-meter-cell { display: inline-flex; align-items: center; gap: 6px; }
  .lt-meter { width: 46px; height: 5px; border-radius: 3px; background: var(--surface); overflow: hidden; flex: 0 0 46px; }
  .lt-meter-fill { display: block; height: 100%; background: var(--ph-coding); }
  .loop-detail-header {
    display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 16px; padding: 16px;
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
  }
  .ldh-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ldh-name { font-size: 1.15rem; font-weight: 600; color: var(--fg-bright); margin: 0; word-break: break-word; }
  .ldh-phase {
    margin-left: auto; font-size: 0.7rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--running); background: rgba(210, 153, 34, 0.12);
    border: 1px solid rgba(210, 153, 34, 0.3);
    padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  }
  .ldh-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px;
  }
  .ldh-stat {
    display: flex; flex-direction: column; gap: 3px;
    padding: 6px 8px; border-radius: 6px;
    background: var(--bg-0); border: 1px solid var(--surface);
  }
  .ldh-stat-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cancelled); }
  .ldh-stat-value { font-size: 0.9rem; color: var(--fg-bright); font-weight: 600; font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; }
  .ldh-bars { display: flex; flex-direction: column; gap: 10px; }
  .ldh-bar-group { display: flex; flex-direction: column; gap: 4px; }
  .ldh-bar-head { display: flex; justify-content: space-between; align-items: baseline; }
  .ldh-bar-label { color: var(--cancelled); text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.66rem; }
  .ldh-bar-count { color: var(--fg-0); font-weight: 600; font-size: 0.78rem; }
  .ldh-bar-track { height: 6px; border-radius: 4px; background: var(--surface); overflow: hidden; }
  .ldh-bar-fill { height: 100%; border-radius: 4px; background: var(--ph-coding); transition: width 0.3s ease; }
  .ldh-banner {
    font-size: 0.82rem; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--divider); color: var(--fg-0);
  }
  .ldh-banner-completed { background: rgba(35, 134, 54, 0.12); border-color: rgba(35, 134, 54, 0.4); color: var(--ok); }
  .ldh-banner-errored { background: rgba(218, 54, 51, 0.12); border-color: rgba(218, 54, 51, 0.4); color: var(--errored); }
  .ldh-banner-cancelled { background: rgba(110, 118, 129, 0.15); border-color: var(--neutral); color: var(--cancelled); }
  .ldh-banner-stalled { background: rgba(210, 153, 34, 0.12); border-color: rgba(210, 153, 34, 0.4); color: var(--running); }
  .ldh-banner-running { background: rgba(31, 111, 235, 0.12); border-color: rgba(31, 111, 235, 0.4); color: var(--link); }
  .ldh-findings { font-size: 0.78rem; font-weight: 600; padding: 6px 12px; border-radius: 6px;
    border: 1px solid var(--divider); align-self: flex-start; }
  .ldh-findings-bug { background: rgba(248,81,73,0.12); border-color: rgba(248,81,73,0.4); color: var(--errored); }
  .ldh-findings-warn { background: rgba(210,153,34,0.12); border-color: rgba(210,153,34,0.4); color: var(--running); }
  .ldh-findings-clean { background: rgba(63,185,80,0.10); border-color: rgba(63,185,80,0.3); color: var(--ok); }
  .markdown-body { padding: 2px 0 4px; }
  .markdown-toc {
    float: right; clear: right;
    margin: 4px 0 8px 12px; padding: 8px 10px;
    max-width: 220px;
    background: var(--panel); border: 1px solid var(--divider); border-radius: 6px;
    font-size: 0.8rem;
  }
  .markdown-toc-title {
    color: var(--fg-1); font-size: 0.72rem;
    text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px;
  }
  .markdown-toc ul { list-style: none; padding: 0; margin: 0; }
  .markdown-toc-item a {
    display: block; color: var(--fg-0); text-decoration: none; padding: 2px 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .markdown-toc-item a:hover { color: var(--accent); }
  .markdown-toc-depth-2 { padding-left: 8px; }
  .markdown-toc-depth-3 { padding-left: 16px; }
  .markdown-toggle {
    display: flex; align-items: center; gap: 8px; min-width: 0;
    cursor: pointer; user-select: none;
  }
  .markdown-toggle:focus-visible {
    outline: 1px solid var(--ph-coding); outline-offset: 2px; border-radius: var(--r-1);
  }
  .markdown-caret {
    flex-shrink: 0; width: 16px; text-align: center;
    color: var(--fg-1); font-size: 0.95rem; line-height: 1;
  }
  .markdown-toggle:hover .markdown-caret { color: var(--fg-bright); }
  .loop-detail .section-label { color: var(--running); }
  .markdown-heading-row {
    display: flex; align-items: center; gap: 8px; margin: 8px 0 4px;
  }
  .markdown-heading-row:first-child { margin-top: 0; }
  .markdown-heading-row h4 { margin: 0; }
  .copy-btn {
    background: var(--surface); color: var(--cancelled); border: 1px solid var(--divider);
    border-radius: 4px; padding: 1px 8px; font-size: 0.72rem;
    cursor: pointer; user-select: none; line-height: 1.5;
    font-family: inherit; flex-shrink: 0;
  }
  .copy-btn:hover { background: var(--divider); color: var(--fg-0); }
  .dashboard-summary { margin-bottom: 12px; }
  .mg-graph {
    margin-bottom: 16px; padding: 12px 16px;
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
  }
  .mg-svg { width: 100%; height: auto; display: block; max-height: 240px; }
  .mg-edge-path {
    fill: none; stroke: var(--divider); stroke-width: 1.5;
    transition: stroke 0.3s ease;
  }
  .mg-edge-label {
    fill: var(--edge-label); font-size: 10px; font-weight: 700;
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace;
    paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round;
    pointer-events: none;
  }
  .mg-node rect {
    fill: var(--bg-0); stroke: var(--divider); stroke-width: 1.5;
    transition: fill 0.2s ease, stroke 0.2s ease;
  }
  .mg-node-label {
    fill: var(--fg-0); font-size: 11px; font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    pointer-events: none;
  }
  .mg-node-active rect {
    fill: rgba(31, 111, 235, 0.18);
    stroke: var(--ph-coding); stroke-width: 2.5;
  }
  .mg-node-active .mg-node-label { fill: var(--fg-bright); }
  .mg-terminal rect {
    fill: var(--bg-0); stroke: var(--neutral); stroke-width: 1.5; stroke-dasharray: 4 3;
  }
  .mg-terminal-label {
    fill: var(--cancelled); font-size: 11px; font-weight: 600; text-transform: uppercase;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    pointer-events: none;
  }
  .mg-history {
    margin-top: 12px; border-top: 1px solid var(--surface); padding-top: 8px;
  }
  .mg-history-title {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--cancelled); margin-bottom: 6px;
  }
  .mg-history-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  .mg-history-row {
    display: flex; align-items: baseline; gap: 8px; font-size: 0.76rem;
    padding: 3px 6px; border-radius: 4px; background: var(--bg-0);
  }
  .mg-history-event {
    color: var(--link); font-weight: 600; flex: 0 0 auto;
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace;
  }
  .mg-history-flow { color: var(--fg-0); flex: 1 1 auto; min-width: 0; }
  .mg-history-time {
    color: var(--cancelled); flex: 0 0 auto;
    font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace;
  }
  .amendments-panel { margin-bottom: 8px; }
  .amendments-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: 0.95rem; }
  .amendments-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .amendment-row { border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0); }
  .amendment-head {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    cursor: pointer; user-select: none; font-size: 0.8rem;
  }
  .amendment-head:hover { background: var(--panel); }
  .amendment-time { color: var(--cancelled); font-family: 'SF Mono','Fira Code',Menlo,Consolas,monospace; font-size: 0.72rem; flex: 0 0 auto; }
  .amendment-section { color: var(--fg-0); font-size: 0.78rem; }
  .amendment-source { color: var(--link); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; flex: 0 0 auto; }
  .amendment-caret { color: var(--cancelled); font-size: 0.7rem; flex: 0 0 10px; }
  .amendment-body { display: none; padding: 6px 10px 8px; border-top: 1px solid var(--surface); }
  .amendment-rationale { font-size: 0.78rem; color: var(--cancelled); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amendment-diff { display: flex; gap: 12px; }
  .amendment-diff-before, .amendment-diff-after { flex: 1; }
  .amendment-diff-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cancelled); margin-bottom: 2px; }
  .amendment-diff-item { font-size: 0.76rem; color: var(--fg-0); padding: 1px 0; }
  .amendment-diff-before .amendment-diff-item { color: var(--errored); }
  .amendment-diff-after .amendment-diff-item { color: var(--ok); }
  .phase-bar {
    display: flex; width: 100%; gap: 0; overflow: hidden;
    border-radius: 3px; background: var(--surface);
  }
  .phase-bar-sm { height: 4px; }
  .phase-bar-md { height: 14px; }
  .phase-bar-lg { height: 22px; }
  .phase-seg { display: block; height: 100%; }
  .phase-seg[data-phase="coding"] { background: var(--ph-coding); }
  .phase-seg[data-phase="auditing"] { background: var(--ph-auditing); }
  .phase-seg[data-phase="final_auditing"] { background: var(--ph-final-auditing); }
  .phase-seg[data-phase="final_audit_fix"] { background: var(--ph-final-audit-fix); }
  .phase-seg[data-phase="post_action"] { background: var(--ph-post-action); }
  .phase-seg-open { opacity: 0.55; outline: 1px dashed var(--fg-bright); outline-offset: -2px; }
  .lt-phase-bar { width: 80px; }
  .phase-bar-trunc { border: 1px dashed var(--running); }
  .phase-bar-trunc-mark {
    display: flex; align-items: center; justify-content: center;
    min-width: 14px; padding: 0 4px;
    font-size: 0.7rem; line-height: 1; color: var(--running);
    background: var(--surface); border-right: 1px dashed var(--running);
  }
  .phase-bar-sm .phase-bar-trunc-mark { font-size: 0.6rem; min-width: 8px; padding: 0 2px; }
  .phase-truncated {
    font-size: 0.72rem; color: var(--running); margin-top: 6px;
    font-style: italic;
  }
  .phase-totals {
    display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px;
    padding: 8px 10px; border: 1px solid var(--surface); border-radius: 6px;
    background: var(--bg-0);
  }
  .phase-totals-row { display: flex; flex-direction: column; gap: 1px; }
  .phase-totals-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cancelled); }
  .phase-totals-value { font-size: 0.82rem; color: var(--fg-bright); font-family: var(--mono); font-weight: 600; }
  .phase-totals-dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 2px;
    margin-right: 5px; vertical-align: middle;
  }
  .phase-totals-dot[data-phase="coding"] { background: var(--ph-coding); }
  .phase-totals-dot[data-phase="auditing"] { background: var(--ph-auditing); }
  .phase-totals-dot[data-phase="final_auditing"] { background: var(--ph-final-auditing); }
  .phase-totals-dot[data-phase="final_audit_fix"] { background: var(--ph-final-audit-fix); }
  .phase-totals-dot[data-phase="post_action"] { background: var(--ph-post-action); }
  .timeline-events { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
  .tl-event {
    display: grid; grid-template-columns: 130px 1fr 90px 60px 60px 90px;
    align-items: baseline; gap: 8px;
    padding: 4px 8px; border-radius: 4px; background: var(--bg-0);
    font-size: 0.78rem;
  }
  .tl-event-time { color: var(--fg-dim); font-family: var(--mono); font-size: 0.72rem; }
  .tl-event-flow { color: var(--fg-0); font-family: var(--mono); }
  .tl-event-kind {
    display: inline-block; padding: 1px 6px;
    border: 1px solid var(--divider); border-radius: 8px;
    background: var(--surface);
    color: var(--link); font-weight: 600; text-transform: uppercase;
    font-size: 0.66rem; letter-spacing: 0.04em;
  }
  .tl-event-iter { color: var(--cancelled); font-family: var(--mono); font-size: 0.72rem; }
  .tl-event-section { color: var(--cancelled); font-family: var(--mono); font-size: 0.72rem; }
  .tl-event-elapsed { color: var(--ok); font-family: var(--mono); font-size: 0.72rem; text-align: right; }
  .tl-event-expand {
    margin-top: 8px; padding: 6px 10px; border: 1px dashed var(--divider);
    border-radius: 4px; color: var(--link); cursor: pointer; user-select: none;
    font-size: 0.78rem; text-align: center;
  }
  .tl-event-expand:hover { background: var(--hover); color: var(--link-hover); }
  .timeline-graph details { margin-top: 14px; border-top: 1px solid var(--surface); padding-top: 10px; }
  .timeline-graph summary { cursor: pointer; color: var(--fg-1); font-size: 0.85rem; font-weight: 600; }
  .timeline-graph summary:hover { color: var(--fg-0); }
  .groups-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: 0.95rem; }
  .groups-list { display: flex; flex-direction: column; gap: 4px; }
  .group-row {
    display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center;
    gap: 10px; padding: 8px 12px; cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-left: 3px solid var(--divider);
    border-radius: 4px; background: var(--bg-0); font-size: 0.85rem;
  }
  .group-row:hover { background: var(--panel); }
  .group-row-active { border-left-color: var(--ph-coding); }
  .group-row-terminal { border-left-color: var(--neutral); }
  .group-row[data-group-status="interrupted"] {
    border-left-color: var(--warning); background: rgba(254, 125, 55, 0.08);
  }
  .group-row[data-group-status="errored"] {
    border-left-color: var(--errored); background: rgba(248, 81, 73, 0.08);
  }
  .group-row-title { color: var(--fg-bright); font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-row-meta { color: var(--fg-dim); font-family: var(--mono); font-size: 0.74rem; }
  .group-row-time { color: var(--fg-dim); font-family: var(--mono); font-size: 0.72rem; }
  .group-detail,
  .group-detail-body { display: flex; flex-direction: column; gap: 12px; }
  .back-to-groups {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    color: var(--link); font-size: 0.85rem; user-select: none;
  }
  .back-to-groups:hover { color: var(--link-hover); }
  .group-header {
    padding: 14px 16px; border: 1px solid var(--divider); border-radius: 8px;
    background: var(--panel); display: flex; flex-direction: column; gap: 10px;
    border-left: 3px solid var(--divider);
  }
  .group-header-terminal { border-left-color: var(--neutral); }
  .group-header-active { border-left-color: var(--ph-coding); }
  .group-header[data-group-status="interrupted"] {
    border-left-color: var(--warning); background: rgba(254, 125, 55, 0.06);
  }
  .group-header[data-group-status="errored"] {
    border-left-color: var(--errored); background: rgba(248, 81, 73, 0.06);
  }
  .group-header-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .group-header-title { font-size: 1.1rem; font-weight: 600; color: var(--fg-bright); margin: 0; word-break: break-word; }
  .group-header-meta { margin-left: auto; color: var(--fg-dim); font-family: var(--mono); font-size: 0.76rem; }
  .group-header-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .group-header-stat { font-size: 0.78rem; color: var(--fg-1); }
  .group-header-error { color: var(--errored); font-size: 0.78rem; }
  .prd-preview {
    margin: 0; padding: 10px 12px; max-height: 240px; overflow: auto;
    background: var(--bg-0); border: 1px solid var(--surface); border-radius: 4px;
    color: var(--fg-0); font-family: var(--mono); font-size: 0.78rem; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  .features-list { display: flex; flex-direction: column; gap: 4px; }
  .feature-row {
    display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: baseline;
    gap: 8px; padding: 7px 10px; border: 1px solid var(--surface); border-radius: 4px;
    background: var(--bg-0); font-size: 0.82rem;
  }
  .feature-index { color: var(--cancelled); font-weight: 600; }
  .feature-stage {
    font-size: 0.66rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; flex-shrink: 0;
  }
  .feature-stage-pending { color: var(--cancelled); }
  .feature-stage-planning,
  .feature-stage-planned { color: var(--link); }
  .feature-stage-launching,
  .feature-stage-running { color: var(--ph-coding); }
  .feature-stage-completed { color: var(--ok); }
  .feature-stage-failed { color: var(--errored); }
  .feature-stage-cancelled { color: var(--neutral); }
  .feature-title { color: var(--fg-0); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feature-attempts { color: var(--fg-dim); font-family: var(--mono); font-size: 0.74rem; }
  .feature-loop-link { color: var(--link); text-decoration: none; font-family: var(--mono); font-size: 0.74rem; }
  .feature-loop-link:hover { color: var(--link-hover); text-decoration: underline; }
  .feature-error { color: var(--errored); font-size: 0.75rem; grid-column: 1 / -1; }
  .findings-panel { display: flex; flex-direction: column; gap: 8px; }
  .findings-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: 0.95rem; }
  .findings-panel-count,
  .plans-panel-count {
    color: var(--fg-dim); font-family: var(--mono); font-size: 0.78rem; font-weight: 400;
  }
  .findings-panel-list { display: flex; flex-direction: column; gap: 10px; }
  .findings-loop-block {
    display: flex; flex-direction: column; gap: 6px;
    border: 1px solid var(--surface); border-radius: 6px; padding: 10px 12px;
    background: var(--bg-0);
  }
  .findings-loop-head {
    display: flex; align-items: baseline; gap: 8px; justify-content: space-between;
  }
  .findings-loop-link { color: var(--link); text-decoration: none; font-weight: 600; }
  .findings-loop-link:hover { color: var(--link-hover); text-decoration: underline; }
  .findings-loop-meta {
    color: var(--fg-dim); font-family: var(--mono); font-size: 0.74rem;
  }
  .plans-panel { display: flex; flex-direction: column; gap: 8px; }
  .plans-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: 0.95rem; }
  .plans-list { display: flex; flex-direction: column; gap: 4px; }
  .plan-row {
    display: grid; grid-template-columns: auto 1fr auto auto; align-items: baseline;
    gap: 10px; padding: 8px 12px; cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0);
    font-size: 0.85rem;
  }
  .plan-row:hover { background: var(--panel); }
  .plan-row-name { color: var(--fg-bright); font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan-row-meta { color: var(--fg-1); font-size: 0.78rem; }
  .plan-row-iter { color: var(--fg-dim); font-family: var(--mono); font-size: 0.74rem; }
</style>
</head>
<body>
  <div id="forge-app-root"></div>
  <script>${MARKED_SOURCE}</script>
  <script type="module">${DASHBOARD_APP_BUNDLE}</script>
</body>
</html>`
}
