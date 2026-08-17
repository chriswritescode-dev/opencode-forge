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
    --bg-0:#0d1117;
    --fg-0:#c9d1d9; --fg-1:#9aa6b4; --fg-2:#6b7684;
    --fg-bright:#f0f6fc; --fg-dim:#484f58; --fg-muted:#6e7681;
    --accent:#4c8dff;
    --surface:#21262d; --panel:#161b22; --hover:#1c2128;
    --divider:#30363d; --link:#58a6ff; --link-hover:#79c0ff;
    --status-running:#4c8dff;
    --status-ok:#3fb950; --status-ok-solid:#238636;
    --status-error:#f85149; --status-error-solid:#da3633;
    --status-attention:#d29922;
    --status-idle:#8b949e;
    --ph-work:#2f81f7; --ph-work-final:#7cb7ff;
    --ph-review:#a371f7; --ph-review-final:#d2a8ff;
    --ph-wrap:#3fb950;
    --ph-coding: var(--ph-work); --ph-auditing: var(--ph-review);
    --ph-final-auditing: var(--ph-review-final); --ph-final-audit-fix: var(--ph-work-final);
    --ph-post-action: var(--ph-wrap);
    --seg-input:#1f6feb; --seg-output:#3fb950; --seg-reasoning:#a371f7;
    --seg-cache-read:#d29922; --seg-cache-write:#db61a2;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
    --r-1:3px; --r-2:6px;
    --edge-label:#f5c518;
    --fs-2xs:0.68rem; --fs-xs:0.74rem; --fs-sm:0.8rem; --fs-md:0.88rem; --fs-lg:1rem;
    --sp-1:4px; --sp-2:6px; --sp-3:8px; --sp-4:12px; --sp-5:16px; --sp-6:24px;
    --app-bar-h:44px;
    --z-subnav:20; --z-app-bar:30; --z-popover:40;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--sans);
    background: var(--bg-0);
    color: var(--fg-0);
    padding: 0;
  }
  h1 { font-size: 1.3rem; color: var(--fg-bright); }
  h1 .forge-home { color: inherit; text-decoration: none; }
  h1 .forge-home:hover { color: var(--link-hover); }
  .app-bar {
    position: sticky; top: 0; z-index: var(--z-app-bar);
    display: flex; align-items: center; gap: var(--sp-4);
    height: var(--app-bar-h); padding: 0 var(--sp-5);
    background: var(--panel); border-bottom: 1px solid var(--divider);
  }
  .app-bar h1 { font-size: var(--fs-lg); margin: 0; white-space: nowrap; }
  .app-bar-nav { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; }
  .app-bar .timestamp { margin: 0 0 0 auto; white-space: nowrap; }
  h2 { font-size: 1.2rem; margin-bottom: 6px; color: var(--fg-bright); }
  .filter-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: var(--sp-3) var(--sp-4); border: 1px solid var(--divider); border-radius: 6px;
    background: var(--panel); font-size: var(--fs-sm);
  }
  .filter-bar .badge {
    padding: var(--sp-1) 10px; border-radius: 12px; font-size: var(--fs-sm);
    background: var(--surface); color: var(--fg-0);
  }
  .filter-bar .badge-filter { cursor: pointer; user-select: none; }
  .filter-bar .badge-filter:hover { background: var(--divider); }
  .filter-bar .badge-active { background: var(--ph-coding); color: #fff; }
  .filter-bar .search-input { margin: 0; max-width: 240px; }
  .sort-select {
    margin-left: auto; padding: var(--sp-1) var(--sp-3); border-radius: 6px;
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-size: var(--fs-sm); font-family: var(--sans); cursor: pointer;
  }
  .sort-select:focus { outline: none; border-color: var(--ph-coding); }
  .search-input {
    width: 100%; max-width: 360px; margin-bottom: 16px;
    padding: var(--sp-2) 10px; border-radius: 6px;
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-size: var(--fs-md);
  }
  .search-input::placeholder { color: var(--fg-dim); }
  .search-input:focus { outline: none; border-color: var(--ph-coding); }
  .forge-app { display: flex; flex-direction: column; }
  .forge-shell {
    display: flex; flex-direction: column; gap: var(--sp-4);
    padding: var(--sp-5) var(--sp-5) var(--sp-6); width: 100%;
  }
  .repo-index { display: flex; gap: var(--sp-5); align-items: flex-start; }
  .repo-index .repo-menu { flex: 0 0 280px; }
  .repo-index-pane { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .repo-index-head { display: flex; flex-direction: column; gap: var(--sp-1); }
  .repo-index-summary { color: var(--fg-1); font-size: var(--fs-md); }
  .repo-index-section { display: flex; flex-direction: column; gap: var(--sp-2); }
  .repo-index-section-title {
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-muted); font-weight: 600;
  }
  .repo-running-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--sp-3); }
  .repo-running-card {
    display: flex; flex-direction: column; gap: 3px; min-width: 0; cursor: pointer; user-select: none;
    padding: var(--sp-3) var(--sp-4); border: 1px solid var(--divider); border-radius: 6px;
    background: var(--panel); font-size: var(--fs-sm);
  }
  .repo-running-card:hover { background: var(--hover); }
  .repo-running-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--status-attention);
    flex: 0 0 8px; box-shadow: 0 0 6px var(--status-attention);
  }
  .repo-running-label {
    display: flex; align-items: center; gap: var(--sp-2); min-width: 0;
    color: var(--link); font-weight: 600;
  }
  .repo-running-name, .repo-running-phase { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-running-name { color: var(--fg-bright); }
  .repo-running-phase {
    color: var(--fg-2); font-family: var(--mono);
    font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.04em;
  }
  .repo-recent-list { display: flex; flex-direction: column; gap: 2px; }
  .repo-recent-row {
    display: grid; grid-template-columns: 110px 140px 1fr auto; align-items: baseline;
    gap: 10px; padding: var(--sp-2) 10px; cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0); font-size: var(--fs-sm);
  }
  .repo-recent-row:hover { background: var(--panel); }
  .repo-recent-label { color: var(--link); font-weight: 600; }
  .repo-recent-name { color: var(--fg-bright); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-recent-when { color: var(--fg-2); font-family: var(--mono); font-size: var(--fs-xs); }
  .repo-menu {
    display: flex; flex-direction: column; gap: 1px;
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
    overflow: hidden;
  }
  .repo-menu-item {
    display: flex; align-items: center; gap: var(--sp-3);
    padding: 10px var(--sp-4); cursor: pointer; user-select: none;
    border-bottom: 1px solid var(--surface); font-size: var(--fs-md); color: var(--fg-0);
  }
  .repo-menu-item:last-child { border-bottom: none; }
  .repo-menu-item:hover { background: var(--hover); }
  .repo-menu-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--link); font-weight: 600;
  }
  .repo-menu-count {
    font-size: var(--fs-2xs); padding: 1px 7px; border-radius: 9px;
    background: var(--divider); color: var(--fg-0);
  }
  .repo-menu-running {
    width: 8px; height: 8px; border-radius: 50%; background: var(--status-attention);
    flex: 0 0 8px; box-shadow: 0 0 6px var(--status-attention);
  }
  .repo-pane { display: flex; flex-direction: column; gap: var(--sp-4); }
  .breadcrumb {
    display: flex; align-items: center; gap: var(--sp-3);
    border: none; background: none; padding: 0; min-width: 0;
    font-size: var(--fs-md);
  }
  .breadcrumb-back { color: var(--link); cursor: pointer; user-select: none; }
  .breadcrumb-back:hover { color: var(--link-hover); }
  .breadcrumb-sep { color: var(--fg-dim); }
  .breadcrumb-label { color: var(--fg-bright); font-weight: 600; }
  .loop-picker { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .breadcrumb-loop {
    padding: 3px var(--sp-2); border-radius: var(--r-1);
    border: 1px solid transparent; background: transparent; cursor: pointer;
    color: var(--fg-bright); font-weight: 600; font-family: var(--sans); font-size: inherit;
    text-overflow: ellipsis;
  }
  .breadcrumb-loop:hover { background: var(--hover); border-color: var(--divider); }
  .breadcrumb-loop:focus { outline: none; cursor: text; background: var(--bg-0); border-color: var(--ph-coding); }
  .breadcrumb-loop::placeholder { color: var(--fg-bright); opacity: 1; }
  .loop-picker-caret { color: var(--fg-2); font-size: var(--fs-2xs); cursor: pointer; user-select: none; }
  .loop-picker-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: var(--z-popover);
    min-width: 340px; max-height: 320px; overflow-y: auto; padding: var(--sp-1);
    border: 1px solid var(--divider); border-radius: var(--r-2);
    background: var(--panel); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  }
  .loop-picker-option {
    display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
    padding: 5px var(--sp-3); border-radius: var(--r-1); cursor: pointer; font-size: var(--fs-sm);
  }
  .loop-picker-option:hover { background: var(--surface); }
  .loop-picker-option-active { background: var(--hover); }
  .loop-picker-option-name {
    color: var(--fg-0); min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .loop-picker-option-current .loop-picker-option-name { color: var(--link); font-weight: 600; }
  .loop-picker-option-when { color: var(--fg-2); font-family: var(--mono); font-size: var(--fs-xs); white-space: nowrap; }
  .loop-picker-empty { padding: var(--sp-2) var(--sp-3); color: var(--fg-2); font-size: var(--fs-sm); }
  .loop-picker-cap { padding: 5px var(--sp-3); font-size: var(--fs-xs); color: var(--fg-dim); border-top: 1px solid var(--divider); }
  .breadcrumb-path {
    margin-left: auto; color: var(--fg-2); font-family: var(--mono);
    font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .breadcrumb-loopnav {
    display: inline-flex; align-items: center; gap: var(--sp-1); margin-left: 10px;
    color: var(--fg-2); font-size: var(--fs-sm); user-select: none;
  }
  .loopnav-prev, .loopnav-next {
    cursor: pointer; padding: 1px var(--sp-2); border-radius: 4px;
    color: var(--link); font-weight: 600;
  }
  .loopnav-prev:hover, .loopnav-next:hover { background: var(--hover); color: var(--link-hover); }
  .loopnav-count { font-family: var(--mono); font-size: var(--fs-xs); color: var(--fg-1); }
  .section-nav {
    position: sticky; top: var(--app-bar-h); z-index: var(--z-subnav);
    display: flex; gap: var(--sp-1); border-bottom: 1px solid var(--divider);
    background: var(--bg-0); padding-top: var(--sp-2);
  }
  .section-nav-item {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4); cursor: pointer; user-select: none;
    color: var(--fg-1); font-size: var(--fs-md); border-bottom: 2px solid transparent;
  }
  .section-nav-item:hover { color: var(--fg-0); background: var(--hover); }
  .section-nav-active {
    color: var(--fg-bright); font-weight: 600;
    border-bottom: 2px solid var(--accent);
  }
  .section-nav-count {
    font-size: var(--fs-2xs); padding: 1px 7px; border-radius: 9px;
    background: var(--divider); color: var(--fg-0);
  }
  .empty-state { padding: var(--sp-6); color: var(--fg-muted); font-size: var(--fs-md); text-align: center; }
  .loop {
    border: 1px solid var(--divider); border-radius: 6px; margin-bottom: 8px;
    background: var(--bg-0);
  }
  .status-badge {
    display: inline-block; padding: 2px var(--sp-3); border-radius: 10px;
    font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase;
  }
  .status-running { background: var(--status-running); color: #fff; }
  .status-completed { background: var(--status-ok-solid); color: #fff; }
  .status-cancelled { background: var(--status-idle); color: #fff; }
  .status-errored { background: var(--status-error-solid); color: #fff; }
  .status-stalled { background: var(--status-attention); color: #fff; }
  .status-extracting { background: var(--link); color: #fff; }
  .status-planning { background: var(--link); color: #fff; }
  .status-interrupted { background: var(--status-attention); color: #fff; }
  .loop-detail { padding: var(--sp-3) var(--sp-4) var(--sp-4); border-top: 1px solid var(--divider); font-size: var(--fs-md); }
  .loop-detail h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: var(--fs-lg); }
  .loop-detail h4:first-child { margin-top: 0; }
  .tab-bar {
    position: sticky; top: var(--app-bar-h); z-index: var(--z-subnav);
    display: flex; flex-wrap: wrap; gap: 2px;
    border-bottom: 1px solid var(--divider); margin-bottom: 8px;
    background: var(--bg-0);
  }
  .tab-item {
    padding: var(--sp-2) var(--sp-4); cursor: pointer; user-select: none;
    color: var(--fg-1); font-size: var(--fs-sm); border-bottom: 2px solid transparent;
  }
  .tab-item:hover { color: var(--fg-0); background: var(--hover); }
  .tab-active { color: var(--fg-bright); font-weight: 600; border-bottom: 2px solid var(--accent); }
  .tab-body { padding: var(--sp-1) 0 var(--sp-3); }
  .tab-empty { padding: var(--sp-5) var(--sp-3); color: var(--fg-dim); font-style: italic; }
  .live-tab { display: flex; flex-direction: column; gap: var(--sp-3); }
  .live-head { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-idle); flex-shrink: 0; }
  .live-dot-live { background: var(--status-ok); }
  .live-dot-idle { background: var(--fg-dim); }
  .live-dot-working { background: var(--status-ok); animation: live-pulse 1.2s ease-in-out infinite; }
  .live-dot-connecting { background: var(--status-attention); }
  .live-dot-failed { background: var(--status-error); }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(127, 220, 140, 0.5); }
    50% { opacity: 0.55; box-shadow: 0 0 0 4px rgba(127, 220, 140, 0); }
  }
  @media (prefers-reduced-motion: reduce) { .live-dot-working { animation: none; } }
  .live-mode-note { color: var(--status-attention); font-size: var(--fs-xs); cursor: help; }
  .live-jump {
    align-self: center; padding: var(--sp-1) var(--sp-4); border-radius: var(--r-1);
    border: 1px solid var(--divider); background: var(--surface); color: var(--fg-0);
    font-family: var(--sans); font-size: var(--fs-xs); cursor: pointer;
  }
  .live-jump:hover { background: var(--hover); }
  .live-status { color: var(--fg-1); text-transform: uppercase; font-size: var(--fs-xs); letter-spacing: 0.05em; }
  .live-session { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); margin-left: auto; }
  .live-failure { color: var(--status-error); font-size: var(--fs-sm); }
  .live-transcript {
    display: flex; flex-direction: column; gap: var(--sp-3);
    max-height: 60vh; overflow-y: auto;
    padding: var(--sp-3); border: 1px solid var(--divider); border-radius: var(--r-2);
    background: var(--panel);
  }
  .live-msg { display: flex; flex-direction: column; gap: var(--sp-1); }
  .live-msg-role {
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-dim); font-weight: 600;
  }
  .live-msg-user .live-msg-role { color: var(--accent); }
  .live-msg-body { display: flex; flex-direction: column; gap: var(--sp-2); }
  .live-text { white-space: pre-wrap; word-break: break-word; font-size: var(--fs-sm); }
  .live-tool {
    display: flex; flex-direction: column; gap: var(--sp-1); align-self: stretch;
    font-family: var(--mono); font-size: var(--fs-xs);
  }
  .live-tool-head {
    display: flex; align-items: baseline; gap: var(--sp-2);
    padding: 1px var(--sp-3); border-radius: var(--r-1);
    background: var(--surface);
  }
  .live-tool-head-clickable { cursor: pointer; }
  .live-tool-head-clickable:hover { background: var(--hover); }
  .live-tool-caret { width: 10px; flex-shrink: 0; color: var(--fg-dim); }
  .live-tool-name { flex-shrink: 0; color: var(--fg-0); font-weight: 600; }
  .live-tool-title {
    flex: 1 1 auto; min-width: 0; color: var(--fg-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .live-tool-status { flex-shrink: 0; color: var(--fg-dim); }
  .live-tool-output {
    margin: 0 0 0 var(--sp-5); padding: var(--sp-2) var(--sp-3);
    max-height: 320px; overflow: auto;
    border-left: 2px solid var(--divider); background: var(--bg-0);
    color: var(--fg-1); font-size: var(--fs-xs); white-space: pre-wrap; word-break: break-word;
  }
  .live-tool-error .live-tool-status { color: var(--status-error); }
  .live-tool-completed .live-tool-status { color: var(--status-ok); }
  .live-composer { display: flex; gap: var(--sp-3); align-items: flex-end; }
  .live-input {
    flex: 1 1 auto; padding: var(--sp-3); border-radius: var(--r-1);
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-family: var(--sans); font-size: var(--fs-md); resize: vertical;
  }
  .live-input:focus { outline: none; border-color: var(--ph-coding); }
  .live-input::placeholder { color: var(--fg-dim); }
  .live-send {
    padding: var(--sp-3) var(--sp-5); border-radius: var(--r-1);
    border: 1px solid var(--ph-coding); background: var(--ph-coding); color: #fff;
    font-family: var(--sans); font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  }
  .live-send:hover:not(:disabled) { filter: brightness(1.1); }
  .live-send:disabled { opacity: 0.5; cursor: default; }
  .live-send-error { color: var(--status-error); font-size: var(--fs-sm); }
  .live-models { border: 1px solid var(--divider); border-radius: var(--r-2); background: var(--panel); }
  .live-models-toggle {
    display: flex; align-items: center; gap: var(--sp-3); width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: none; border: none; color: var(--fg-0);
    font-family: var(--sans); font-size: var(--fs-sm); cursor: pointer; text-align: left;
  }
  .live-models-caret { color: var(--fg-1); width: 12px; }
  .live-models-summary {
    margin-left: auto; color: var(--fg-dim);
    font-family: var(--mono); font-size: var(--fs-xs);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .live-models-body {
    display: flex; flex-direction: column; gap: var(--sp-3);
    padding: 0 var(--sp-3) var(--sp-3);
  }
  .live-model-row { display: flex; align-items: center; gap: var(--sp-3); }
  .live-model-label { flex: 0 0 72px; color: var(--fg-1); font-size: var(--fs-xs); text-transform: uppercase; }
  .live-model-select, .live-variant-select {
    padding: var(--sp-1) var(--sp-2); border-radius: var(--r-1);
    border: 1px solid var(--divider); background: var(--bg-0); color: var(--fg-0);
    font-family: var(--sans); font-size: var(--fs-sm); cursor: pointer;
  }
  .live-model-select { flex: 1 1 auto; min-width: 0; color: var(--fg-bright); font-weight: 600; }
  .live-variant-select { flex: 0 0 auto; max-width: 180px; }
  .live-variant-select:disabled { opacity: 0.4; cursor: default; }
  .live-model-actions { display: flex; align-items: center; gap: var(--sp-3); }
  .live-model-hint { flex: 1 1 auto; color: var(--fg-dim); font-size: var(--fs-xs); }
  .live-models-error { color: var(--status-error); font-size: var(--fs-xs); }
  .live-models-ok { color: var(--status-ok); font-size: var(--fs-xs); }
  .findings-tab { display: flex; flex-direction: column; gap: var(--sp-4); }
  .findings-group { display: flex; flex-direction: column; gap: var(--sp-2); }
  .findings-group-label {
    font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--accent); font-weight: 600;
  }
  .finding-time {
    color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs);
    flex: 0 0 auto; margin-right: 8px;
  }
  .finding-text { flex: 1 1 auto; min-width: 0; }
  .section-caret { color: var(--fg-muted); font-size: var(--fs-2xs); width: 10px; flex-shrink: 0; }
  .section-status {
    font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; flex-shrink: 0;
  }
  .section-pending { color: var(--fg-muted); }
  .section-in_progress { color: var(--link); }
  .section-completed { color: var(--status-ok); }
  .section-failed { color: var(--status-error); }
  .section-index { color: var(--fg-muted); font-weight: 600; flex-shrink: 0; }
  .section-adjusted {
    font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--status-attention); flex-shrink: 0;
  }
  .section-title {
    color: var(--fg-0); flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .section-duration { color: var(--fg-muted); font-size: var(--fs-xs); flex-shrink: 0; font-family: var(--mono); }
  .section-attempts { color: var(--status-attention); font-size: var(--fs-xs); flex-shrink: 0; font-family: var(--mono); }
  .sections-panel { display: flex; flex-direction: column; gap: var(--sp-3); }
  .section-list { display: flex; flex-direction: column; gap: var(--sp-2); }
  .section-list-row { display: flex; align-items: center; gap: var(--sp-3); padding: 7px 10px; cursor: pointer;
    border: 1px solid var(--surface); border-left: 3px solid var(--divider); border-radius: 4px; background: var(--bg-0); }
  .section-list-row:hover { background: var(--panel); }
  .section-item-pending { border-left-color: var(--status-idle); }
  .section-item-in_progress { border-left-color: var(--ph-coding); }
  .section-item-completed { border-left-color: var(--status-ok); }
  .section-item-failed { border-left-color: var(--status-error); }
  .back-to-sections { display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer;
    color: var(--link); font-size: var(--fs-md); margin-bottom: 10px; user-select: none; }
  .back-to-sections:hover { color: var(--link-hover); }
  .section-drill-title { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: 8px; }
  .section-body {
    padding: 10px var(--sp-4) var(--sp-4); border-top: 1px solid var(--surface);
    display: flex; flex-direction: column; gap: 10px;
  }
  .section-timing { font-size: var(--fs-sm); color: var(--fg-muted); }
  .section-summary-part { display: flex; flex-direction: column; gap: 3px; }
  .section-summary-label {
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-muted);
  }
  .section-empty { font-size: var(--fs-sm); color: var(--fg-dim); font-style: italic; }
  .finding { padding: 2px 0; display: flex; align-items: baseline; gap: var(--sp-1); }
  .finding-bug { color: var(--status-error); }
  .finding-warning { color: var(--status-attention); }
  .usage-group { display: flex; flex-direction: column; gap: var(--sp-4); }
  .usage-block {
    border: 1px solid var(--surface); border-radius: 6px; padding: 10px var(--sp-4); background: var(--bg-0);
  }
  .usage-block-title {
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-muted); margin-bottom: 8px;
  }
  .usage-stack {
    display: flex; height: 12px; border-radius: 4px; overflow: hidden;
    background: var(--surface); margin-bottom: 10px;
  }
  .usage-stack-seg { height: 100%; min-width: 2px; transition: width 0.3s ease; }
  .usage-stack-seg:not(:last-child) { border-right: 1px solid var(--bg-0); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) 14px; }
  .legend-item { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); }
  .legend-dot { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 9px; }
  .legend-label { color: var(--fg-muted); }
  .legend-value { color: var(--fg-bright); font-weight: 600; }
  .usage-models { display: flex; flex-direction: column; gap: 10px; }
  .usage-model-row { display: flex; flex-direction: column; gap: var(--sp-1); }
  .usage-model-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .usage-model-name {
    color: var(--fg-0); font-size: var(--fs-sm); font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .usage-model-cost { color: var(--status-ok); font-weight: 600; font-size: var(--fs-sm); flex-shrink: 0; }
  .usage-model-track { height: 6px; border-radius: 4px; background: var(--surface); overflow: hidden; }
  .usage-model-fill { height: 100%; border-radius: 4px; background: var(--ph-coding); transition: width 0.3s ease; }
  .usage-model-meta { font-size: var(--fs-xs); color: var(--fg-muted); }
  .timestamp { font-size: var(--fs-xs); color: var(--fg-dim); }
  .error-text { color: var(--status-error); padding: var(--sp-3) var(--sp-5); }
  .dim { color: var(--fg-dim); }
  .resizable-block {
    resize: vertical; overflow: auto;
    min-height: 0; height: auto; max-height: 60vh;
    border: 1px solid var(--divider); border-radius: 4px;
    background: var(--bg-0); padding: var(--sp-3); margin-top: 4px;
  }
  .markdown-content { font-size: var(--fs-md); line-height: 1.6; color: var(--fg-0); }
  .markdown-content h1 { font-size: 1.3rem; margin: 16px 0 8px; color: var(--accent); border-bottom: 1px solid var(--divider); padding-bottom: var(--sp-1); }
  .markdown-content h2 { font-size: 1.15rem; margin: 14px 0 6px; color: var(--accent); border-bottom: 1px solid var(--surface); padding-bottom: 3px; }
  .markdown-content h3 { font-size: 1.05rem; margin: 12px 0 5px; color: var(--accent); }
  .markdown-content h4 { font-size: var(--fs-lg); margin: 10px 0 4px; color: var(--accent); }
  .markdown-content p { margin: 6px 0; }
  .markdown-content ul, .markdown-content ol { margin: 4px 0; padding-left: 20px; }
  .markdown-content li { margin: 2px 0; }
  .markdown-content code {
    background: var(--surface); border-radius: 3px; padding: 1px 5px;
    font-family: var(--mono);
    font-size: var(--fs-sm); color: var(--fg-bright);
  }
  .markdown-content pre {
    background: var(--panel); border: 1px solid var(--divider); border-radius: 6px;
    padding: var(--sp-4); overflow-x: auto; margin: 8px 0;
  }
  .markdown-content pre code {
    background: none; padding: 0; border-radius: 0;
    font-size: var(--fs-sm); color: var(--fg-0); line-height: 1.5;
  }
  .markdown-content blockquote {
    border-left: 3px solid var(--divider); padding-left: var(--sp-4); margin: 8px 0;
    color: var(--fg-muted);
  }
  .markdown-content table { border-collapse: collapse; margin: 8px 0; font-size: var(--fs-sm); }
  .markdown-content th, .markdown-content td {
    border: 1px solid var(--divider); padding: var(--sp-1) var(--sp-3); text-align: left;
  }
  .markdown-content th { background: var(--panel); color: var(--fg-bright); font-weight: 600; }
  .markdown-content hr { border: none; border-top: 1px solid var(--divider); margin: 12px 0; }
  .markdown-content strong { color: var(--fg-bright); }
  .markdown-content a { color: var(--link); text-decoration: none; }
  .markdown-content a:hover { text-decoration: underline; }
  .markdown-content img { max-width: 100%; border-radius: 4px; }
  .loop-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .loop-table-wrap { display: flex; flex-direction: column; gap: var(--sp-2); }
  .list-cap-notice { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-1); font-size: var(--fs-sm); color: var(--fg-dim); }
  .list-cap-text { color: var(--fg-dim); }
  .list-cap-show-all { padding: 2px var(--sp-3); font: inherit; color: var(--fg-0); background: var(--panel); border: 1px solid var(--divider); border-radius: var(--r-1); cursor: pointer; }
  .list-cap-show-all:hover { border-color: var(--fg-0); }
  .loop-table th {
    text-align: left; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-muted); font-weight: 600; padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--divider); white-space: nowrap;
    position: sticky; top: calc(var(--app-bar-h) + 36px); background: var(--bg-0); z-index: 1;
  }
  .loop-table td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--surface); vertical-align: middle; }
  .lt-row { cursor: pointer; }
  .lt-row:nth-child(even) { background: var(--bg-0); }
  .lt-row:nth-child(odd) { background: var(--panel); }
  .lt-row:hover { background: var(--hover); }
  .lt-name { color: var(--link); font-weight: 600; }
  .lt-phase, .lt-cost, .lt-duration, .lt-updated, .lt-meter-text {
    font-family: var(--mono); color: var(--fg-muted); }
  .group-row .lt-meter-text { font-size: var(--fs-xs); }
  .lt-cost { color: var(--status-ok); }
  td[data-col="cost"], td[data-col="duration"], td[data-col="iter"], td[data-col="sections"],
  th[data-col="cost"], th[data-col="duration"], th[data-col="iter"], th[data-col="sections"] { text-align: right; }
  .lt-meter-cell { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .lt-meter { width: 46px; height: 5px; border-radius: 3px; background: var(--surface); overflow: hidden; flex: 0 0 46px; }
  .lt-meter-fill { display: block; height: 100%; background: var(--ph-coding); }
  .loop-detail-header {
    display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 16px; padding: var(--sp-5);
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
  }
  .ldh-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ldh-name { font-size: 1.15rem; font-weight: 600; color: var(--fg-bright); margin: 0; word-break: break-word; }
  .ldh-phase {
    margin-left: auto; font-size: var(--fs-2xs); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--status-running); background: rgba(76, 141, 255, 0.12);
    border: 1px solid rgba(76, 141, 255, 0.3);
    padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  }
  .ldh-primary {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--sp-3);
  }
  .ldh-cell {
    display: flex; flex-direction: column; gap: var(--sp-1);
    padding: var(--sp-3) var(--sp-4); border: 1px solid var(--divider);
    border-radius: var(--r-2); background: var(--bg-0);
  }
  .ldh-cell-stat {
    gap: 3px; padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--surface); border-radius: 6px;
  }
  .ldh-cell-label { font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-muted); }
  .ldh-cell-value { font-size: 1.05rem; font-weight: 600; color: var(--fg-bright); font-family: var(--mono); }
  .ldh-cell-value-stat { font-size: var(--fs-md); overflow-wrap: anywhere; }
  .ldh-cell-bug { border-color: var(--status-error); }
  .ldh-cell-warn { border-color: var(--status-attention); }
  .ldh-cell-clean { border-color: var(--status-ok); }
  .ldh-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px;
  }
  .ldh-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--sp-4); }
  .ldh-group { display: flex; flex-direction: column; gap: var(--sp-2); }
  .ldh-group-label { font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-muted); font-weight: 600; }
  .ldh-bars { display: flex; flex-direction: column; gap: 10px; }
  .ldh-bar-group { display: flex; flex-direction: column; gap: var(--sp-1); }
  .ldh-bar-head { display: flex; justify-content: space-between; align-items: baseline; }
  .ldh-bar-label { color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; font-size: var(--fs-2xs); }
  .ldh-bar-count { color: var(--fg-0); font-weight: 600; font-size: var(--fs-sm); }
  .ldh-bar-track { height: 6px; border-radius: 4px; background: var(--surface); overflow: hidden; }
  .ldh-bar-fill { height: 100%; border-radius: 4px; background: var(--ph-coding); transition: width 0.3s ease; }
  .ldh-banner {
    font-size: var(--fs-sm); padding: var(--sp-3) var(--sp-4); border-radius: 6px;
    border: 1px solid var(--divider); color: var(--fg-0);
  }
  .ldh-banner-completed { background: rgba(35, 134, 54, 0.12); border-color: rgba(35, 134, 54, 0.4); color: var(--status-ok); }
  .ldh-banner-errored { background: rgba(218, 54, 51, 0.12); border-color: rgba(218, 54, 51, 0.4); color: var(--status-error); }
  .ldh-banner-cancelled { background: rgba(139, 148, 158, 0.15); border-color: var(--status-idle); color: var(--status-idle); }
  .ldh-banner-stalled { background: rgba(210, 153, 34, 0.12); border-color: rgba(210, 153, 34, 0.4); color: var(--status-attention); }
  .ldh-banner-running { background: rgba(31, 111, 235, 0.12); border-color: rgba(31, 111, 235, 0.4); color: var(--link); }
  .ldh-amendments {
    font-size: var(--fs-xs); font-weight: 600; padding: var(--sp-2) var(--sp-4);
    border-radius: var(--r-2); border: 1px solid var(--status-attention);
    background: rgba(210,153,34,0.12); color: var(--status-attention);
    cursor: pointer; font-family: var(--sans); white-space: nowrap;
  }
  .ldh-amendments:hover { background: rgba(210,153,34,0.2); border-color: rgba(210,153,34,0.55); }
  .markdown-body { padding: 2px 0 var(--sp-1); }
  .markdown-toc {
    float: right; clear: right;
    margin: 4px 0 8px 12px; padding: var(--sp-3) 10px;
    max-width: 220px;
    background: var(--panel); border: 1px solid var(--divider); border-radius: 6px;
    font-size: var(--fs-sm);
  }
  .markdown-toc-title {
    color: var(--fg-1); font-size: var(--fs-xs);
    text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px;
  }
  .markdown-toc ul { list-style: none; padding: 0; margin: 0; }
  .markdown-toc-item a {
    display: block; color: var(--fg-0); text-decoration: none; padding: 2px 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .markdown-toc-item a:hover { color: var(--accent); }
  .markdown-toc-depth-2 { padding-left: var(--sp-3); }
  .markdown-toc-depth-3 { padding-left: var(--sp-5); }
  .markdown-toggle {
    display: flex; align-items: center; gap: var(--sp-3); min-width: 0;
    cursor: pointer; user-select: none;
  }
  .markdown-toggle:focus-visible {
    outline: 1px solid var(--ph-coding); outline-offset: 2px; border-radius: var(--r-1);
  }
  .markdown-caret {
    flex-shrink: 0; width: 16px; text-align: center;
    color: var(--fg-1); font-size: var(--fs-lg); line-height: 1;
  }
  .markdown-toggle:hover .markdown-caret { color: var(--fg-bright); }
  .loop-detail .section-label { color: var(--status-attention); }
  .markdown-heading-row {
    display: flex; align-items: center; gap: var(--sp-3); margin: 8px 0 4px;
  }
  .markdown-heading-row:first-child { margin-top: 0; }
  .markdown-heading-row h4 { margin: 0; }
  .copy-btn {
    background: var(--surface); color: var(--fg-muted); border: 1px solid var(--divider);
    border-radius: 4px; padding: 1px var(--sp-3); font-size: var(--fs-xs);
    cursor: pointer; user-select: none; line-height: 1.5;
    font-family: var(--sans); flex-shrink: 0;
  }
  .copy-btn:hover { background: var(--divider); color: var(--fg-0); }
  .mg-graph {
    margin-bottom: 16px; padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--divider); border-radius: 8px; background: var(--panel);
  }
  .mg-svg { width: 100%; height: auto; display: block; max-height: 240px; }
  .mg-edge-path {
    fill: none; stroke: var(--divider); stroke-width: 1.5;
    transition: stroke 0.3s ease;
  }
  .mg-edge-label {
    fill: var(--edge-label); font-size: 10px; font-weight: 700;
    font-family: var(--mono);
    paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round;
    pointer-events: none;
  }
  .mg-node rect {
    fill: var(--bg-0); stroke: var(--divider); stroke-width: 1.5;
    transition: fill 0.2s ease, stroke 0.2s ease;
  }
  .mg-node-label {
    fill: var(--fg-0); font-size: 11px; font-weight: 600;
    font-family: var(--sans);
    pointer-events: none;
  }
  .mg-node-active rect {
    fill: rgba(31, 111, 235, 0.18);
    stroke: var(--ph-coding); stroke-width: 2.5;
  }
  .mg-node-active .mg-node-label { fill: var(--fg-bright); }
  .mg-terminal rect {
    fill: var(--bg-0); stroke: var(--status-idle); stroke-width: 1.5; stroke-dasharray: 4 3;
  }
  .mg-terminal-label {
    fill: var(--fg-muted); font-size: 11px; font-weight: 600; text-transform: uppercase;
    font-family: var(--sans);
    pointer-events: none;
  }
  .mg-history {
    margin-top: 12px; border-top: 1px solid var(--surface); padding-top: var(--sp-3);
  }
  .mg-history-title {
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-muted); margin-bottom: 6px;
  }
  .mg-history-list { display: flex; flex-direction: column; gap: var(--sp-1); max-height: 220px; overflow-y: auto; }
  .mg-history-row {
    display: flex; align-items: baseline; gap: var(--sp-3); font-size: var(--fs-xs);
    padding: 3px var(--sp-2); border-radius: 4px; background: var(--bg-0);
  }
  .mg-history-event {
    color: var(--link); font-weight: 600; flex: 0 0 auto;
    font-family: var(--mono);
  }
  .mg-history-flow { color: var(--fg-0); flex: 1 1 auto; min-width: 0; }
  .mg-history-time {
    color: var(--fg-muted); flex: 0 0 auto;
    font-family: var(--mono);
  }
  .amendments-panel { margin-bottom: 8px; }
  .amendments-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: var(--fs-lg); }
  .amendments-list { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: 6px; }
  .amendment-row { border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0); }
  .amendment-head {
    display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) 10px;
    cursor: pointer; user-select: none; font-size: var(--fs-sm);
  }
  .amendment-head:hover { background: var(--panel); }
  .amendment-time { color: var(--fg-muted); font-family: var(--mono); font-size: var(--fs-xs); flex: 0 0 auto; }
  .amendment-section { color: var(--fg-0); font-size: var(--fs-sm); }
  .amendment-source { color: var(--link); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; flex: 0 0 auto; }
  .amendment-summary { display: inline-flex; gap: var(--sp-1); flex: 0 0 auto; }
  .amendment-count { font-family: var(--mono); font-size: var(--fs-xs); font-weight: 600; color: var(--fg-0); padding: 0 var(--sp-1); border-radius: var(--r-1); }
  .amendment-count-add { color: var(--status-ok); }
  .amendment-count-remove { color: var(--status-error); }
  .amendment-count-modified { color: var(--status-attention); }
  .amendment-caret { color: var(--fg-muted); font-size: var(--fs-2xs); flex: 0 0 10px; }
  .amendment-body { display: none; padding: var(--sp-2) 10px var(--sp-3); border-top: 1px solid var(--surface); }
  .amendment-rationale { font-size: var(--fs-sm); color: var(--fg-muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amendment-diff { display: flex; flex-direction: column; gap: var(--sp-2); }
  .amendment-diff-loading { font-size: var(--fs-sm); color: var(--fg-muted); font-style: italic; }
  .amendment-diff-error { font-size: var(--fs-sm); color: var(--status-error); }
  .amendment-diff-empty { font-size: var(--fs-sm); color: var(--fg-muted); font-style: italic; }
  .amendment-diff-section { border: 1px solid var(--surface); border-radius: var(--r-1); background: var(--bg-0); padding: var(--sp-2) var(--sp-3); }
  .amendment-diff-head { display: flex; align-items: baseline; gap: var(--sp-2) var(--sp-3); flex-wrap: wrap; }
  .amendment-diff-index { font-family: var(--mono); font-size: var(--fs-xs); color: var(--fg-muted); flex: 0 0 auto; }
  .amendment-diff-change { font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--link); font-weight: 600; flex: 0 0 auto; }
  .amendment-diff-title { font-size: var(--fs-sm); color: var(--fg-bright); font-weight: 600; }
  .amendment-diff-prev { font-size: var(--fs-xs); color: var(--fg-muted); }
  .amendment-diff-line { font-family: var(--mono); font-size: var(--fs-xs); color: var(--fg-0); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  .amendment-diff-line-add { color: var(--status-ok); }
  .amendment-diff-line-remove { color: var(--status-error); }
  .amendment-diff-line-context { color: var(--fg-muted); }
  .amendment-diff-line-gap { color: var(--fg-muted); font-style: italic; }
  .phase-bar {
    display: flex; width: 100%; gap: 0; overflow: hidden;
    border-radius: 3px; background: var(--surface);
  }
  .phase-bar-sm { height: 4px; }
  .phase-bar-md { height: 14px; }
  .phase-bar-lg { height: 22px; }
  [data-phase="coding"] { --phase-color: var(--ph-coding); }
  [data-phase="auditing"] { --phase-color: var(--ph-auditing); }
  [data-phase="final_auditing"] { --phase-color: var(--ph-final-auditing); }
  [data-phase="final_audit_fix"] { --phase-color: var(--ph-final-audit-fix); }
  [data-phase="post_action"] { --phase-color: var(--ph-post-action); }
  .phase-seg { display: block; height: 100%; min-width: 2px; background: var(--phase-color); }
  .phase-seg-open { opacity: 0.55; outline: 1px dashed var(--fg-bright); outline-offset: -2px; }
  .lt-phase-bar { width: 80px; }
  .lt-phase-chip {
    display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-1);
    font-size: var(--fs-2xs); font-weight: 600; color: var(--bg-0);
    background: var(--phase-color);
  }
  .phase-bar-trunc { border: 1px dashed var(--status-attention); }
  .phase-bar-trunc-mark {
    display: flex; align-items: center; justify-content: center;
    min-width: 14px; padding: 0 var(--sp-1);
    font-size: var(--fs-2xs); line-height: 1; color: var(--status-attention);
    background: var(--surface); border-right: 1px dashed var(--status-attention);
  }
  .phase-bar-sm .phase-bar-trunc-mark { font-size: var(--fs-2xs); min-width: 8px; padding: 0 2px; }
  .phase-truncated {
    font-size: var(--fs-xs); color: var(--status-attention); margin-top: 6px;
    font-style: italic;
  }
  .legend-phase { gap: var(--sp-1) var(--sp-5); margin-top: var(--sp-2); }
  .legend-phase .legend-dot { margin-right: 5px; background: var(--phase-color); }
  .legend-phase .legend-label { color: var(--fg-1); }
  .legend-phase .legend-value { font-family: var(--mono); }
  .timeline-events { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
  .tl-event {
    display: grid; grid-template-columns: 130px 1fr 90px 60px 60px 90px;
    align-items: baseline; gap: var(--sp-3);
    padding: var(--sp-1) var(--sp-3); border-radius: 4px; background: var(--bg-0);
    font-size: var(--fs-sm);
  }
  .tl-event-time { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  .tl-event-flow { color: var(--fg-0); font-family: var(--mono); }
  .tl-event-kind {
    display: inline-block; padding: 1px var(--sp-2);
    border: 1px solid var(--divider); border-radius: 8px;
    background: var(--surface);
    color: var(--link); font-weight: 600; text-transform: uppercase;
    font-size: var(--fs-2xs); letter-spacing: 0.04em;
  }
  .tl-event-iter { color: var(--fg-muted); font-family: var(--mono); font-size: var(--fs-xs); }
  .tl-event-section { color: var(--fg-muted); font-family: var(--mono); font-size: var(--fs-xs); }
  .tl-event-elapsed { color: var(--status-ok); font-family: var(--mono); font-size: var(--fs-xs); text-align: right; }
  .tl-amendment {
    display: flex; align-items: baseline; gap: var(--sp-3);
    padding: var(--sp-1) var(--sp-3); border-radius: var(--r-1);
    border-left: 3px solid var(--status-attention); background: rgba(210,153,34,0.08);
    font-size: var(--fs-xs);
  }
  .tl-amendment-kind {
    display: inline-block; padding: 1px var(--sp-2);
    border: 1px solid var(--status-attention); border-radius: 8px;
    background: rgba(210,153,34,0.12);
    color: var(--status-attention); font-weight: 700; text-transform: uppercase;
    font-size: var(--fs-2xs); letter-spacing: 0.04em;
  }
  .tl-amendment-section { color: var(--fg-muted); font-family: var(--mono); }
  .tl-amendment-rationale { color: var(--fg-0); flex: 1 1 auto; min-width: 0; }
  .tl-event-expand {
    margin-top: 8px; padding: var(--sp-2) 10px; border: 1px dashed var(--divider);
    border-radius: 4px; color: var(--link); cursor: pointer; user-select: none;
    font-size: var(--fs-sm); text-align: center;
  }
  .tl-event-expand:hover { background: var(--hover); color: var(--link-hover); }
  .timeline-graph details { margin-top: 14px; border-top: 1px solid var(--surface); padding-top: 10px; }
  .timeline-graph summary { cursor: pointer; color: var(--fg-1); font-size: var(--fs-md); font-weight: 600; }
  .timeline-graph summary:hover { color: var(--fg-0); }
  .groups-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: var(--fs-lg); }
  .groups-list { display: flex; flex-direction: column; gap: var(--sp-1); }
  .group-row {
    display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center;
    gap: 10px; padding: var(--sp-3) var(--sp-4); cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-left: 3px solid var(--divider);
    border-radius: 4px; background: var(--bg-0); font-size: var(--fs-md);
  }
  .group-row:hover { background: var(--panel); }
  .group-row-active { border-left-color: var(--ph-coding); }
  .group-row-terminal { border-left-color: var(--status-idle); }
  .group-row[data-group-status="interrupted"] {
    border-left-color: var(--status-attention); background: rgba(210, 153, 34, 0.08);
  }
  .group-row[data-group-status="errored"] {
    border-left-color: var(--status-error); background: rgba(248, 81, 73, 0.08);
  }
  .group-row-title { color: var(--fg-bright); font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-row-meta { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  .group-row-time { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  .group-detail,
  .group-detail-body { display: flex; flex-direction: column; gap: var(--sp-4); }
  .back-to-groups {
    display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer;
    color: var(--link); font-size: var(--fs-md); user-select: none;
  }
  .back-to-groups:hover { color: var(--link-hover); }
  .group-header {
    padding: 14px var(--sp-5); border: 1px solid var(--divider); border-radius: 8px;
    background: var(--panel); display: flex; flex-direction: column; gap: 10px;
    border-left: 3px solid var(--divider);
  }
  .group-header-terminal { border-left-color: var(--status-idle); }
  .group-header-active { border-left-color: var(--ph-coding); }
  .group-header[data-group-status="interrupted"] {
    border-left-color: var(--status-attention); background: rgba(210, 153, 34, 0.06);
  }
  .group-header[data-group-status="errored"] {
    border-left-color: var(--status-error); background: rgba(248, 81, 73, 0.06);
  }
  .group-header-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .group-header-title { font-size: 1.1rem; font-weight: 600; color: var(--fg-bright); margin: 0; word-break: break-word; }
  .group-header-meta { margin-left: auto; color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  .group-header-stats { display: flex; flex-wrap: wrap; gap: var(--sp-2) 14px; }
  .group-header-stat { font-size: var(--fs-sm); color: var(--fg-1); }
  .group-header-error { color: var(--status-error); font-size: var(--fs-sm); }
  .prd-preview {
    margin: 0; padding: 10px var(--sp-4); max-height: 240px; overflow: auto;
    background: var(--bg-0); border: 1px solid var(--surface); border-radius: 4px;
    color: var(--fg-0); font-family: var(--mono); font-size: var(--fs-sm); line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  .features-list { display: flex; flex-direction: column; gap: var(--sp-1); }
  .feature-row {
    display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: baseline;
    gap: var(--sp-3); padding: 7px 10px; border: 1px solid var(--surface); border-radius: 4px;
    background: var(--bg-0); font-size: var(--fs-sm);
  }
  .feature-index { color: var(--fg-muted); font-weight: 600; }
  .feature-stage {
    font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; flex-shrink: 0;
  }
  .feature-stage-pending { color: var(--fg-muted); }
  .feature-stage-planning,
  .feature-stage-planned { color: var(--link); }
  .feature-stage-launching,
  .feature-stage-running { color: var(--ph-coding); }
  .feature-stage-completed { color: var(--status-ok); }
  .feature-stage-failed { color: var(--status-error); }
  .feature-stage-cancelled { color: var(--status-idle); }
  .feature-title { color: var(--fg-0); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feature-attempts { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  .feature-loop-link { color: var(--link); text-decoration: none; font-family: var(--mono); font-size: var(--fs-xs); }
  .feature-loop-link:hover { color: var(--link-hover); text-decoration: underline; }
  .feature-error { color: var(--status-error); font-size: var(--fs-xs); grid-column: 1 / -1; }
  .findings-panel { display: flex; flex-direction: column; gap: var(--sp-3); }
  .findings-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: var(--fs-lg); }
  .findings-panel-count,
  .plans-panel-count {
    color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-sm); font-weight: 400;
  }
  .findings-panel-list { display: flex; flex-direction: column; gap: 10px; }
  .findings-loop-block {
    display: flex; flex-direction: column; gap: var(--sp-2);
    border: 1px solid var(--surface); border-radius: 6px; padding: 10px var(--sp-4);
    background: var(--bg-0);
  }
  .findings-loop-head {
    display: flex; align-items: baseline; gap: var(--sp-3); justify-content: space-between;
  }
  .findings-loop-link { color: var(--link); text-decoration: none; font-weight: 600; }
  .findings-loop-link:hover { color: var(--link-hover); text-decoration: underline; }
  .findings-loop-meta {
    color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs);
  }
  .plans-panel { display: flex; flex-direction: column; gap: var(--sp-3); }
  .plans-panel h4 { color: var(--fg-bright); margin: 8px 0 4px; font-size: var(--fs-lg); }
  .plans-list { display: flex; flex-direction: column; gap: var(--sp-1); }
  .plan-row {
    display: grid; grid-template-columns: auto 1fr auto auto; align-items: baseline;
    gap: 10px; padding: var(--sp-3) var(--sp-4); cursor: pointer; user-select: none;
    border: 1px solid var(--surface); border-radius: 4px; background: var(--bg-0);
    font-size: var(--fs-md);
  }
  .plan-row:hover { background: var(--panel); }
  .plan-row-name { color: var(--fg-bright); font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan-row-meta { color: var(--fg-1); font-size: var(--fs-sm); }
  .plan-row-iter { color: var(--fg-dim); font-family: var(--mono); font-size: var(--fs-xs); }
  @media (max-width: 1100px) {
    [data-col="span"], [data-col="iter"], [data-col="sections"] { display: none; }
  }
  @media (max-width: 820px) {
    [data-col="phase"], [data-col="updated"] { display: none; }
    :root { --app-bar-h: 60px; }
    .app-bar { height: auto; padding: var(--sp-2) var(--sp-4); flex-wrap: wrap; }
    .repo-index { flex-direction: column; }
    .repo-index .repo-menu { flex: 0 0 auto; width: 100%; }
  }
</style>
</head>
<body>
  <div id="forge-app-root"></div>
  <script>${MARKED_SOURCE}</script>
  <script type="module">${DASHBOARD_APP_BUNDLE}</script>
</body>
</html>`
}
