import { MARKED_SOURCE } from './marked-source'

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge Dashboard</title>
<script>${MARKED_SOURCE}</script>
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
</style>
</head>
<body>
  <h1>Forge Dashboard</h1>
  <div id="totals-bar" class="totals"></div>
  <input id="loop-search" class="search-input" type="text" placeholder="Filter by loop name or project…" autocomplete="off">
  <div id="timestamp" class="timestamp"></div>
  <div id="forge-dashboard"></div>
<script id="forge-app">
  (function(){
    var activeStatuses = new Set();
    var searchText = '';
    var lastData = null;
    var selectedProjectId = null;
    var selectedLoopName = null;

    function load() {
      fetch('/api/data', { cache: 'no-store' })
        .then(function(r) { return r.json(); })
        .then(function(data) { render(data); })
        .catch(function(err) {
          var mount = document.getElementById('forge-dashboard');
          if (mount) {
            mount.textContent = '';
            var errEl = document.createElement('div');
            errEl.className = 'error-text';
            errEl.textContent = 'Failed to load dashboard data: ' + err.message;
            mount.appendChild(errEl);
          }
        });
    }

    function fmtTime(ts) {
      if (!ts || ts === 0) return '';
      var d = new Date(ts);
      var pad = function(n) { return n < 10 ? '0' + n : String(n); };
      var month = pad(d.getMonth() + 1);
      var day = pad(d.getDate());
      var year = d.getFullYear();
      var hours = d.getHours();
      var ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      if (hours === 0) hours = 12;
      return month + '-' + day + '-' + year + ' ' + hours + ':' + pad(d.getMinutes()) + ' ' + ampm;
    }

    function statusClass(status) {
      return 'status-badge status-' + status;
    }

    function loopMatchesFilters(lp, proj) {
      var statusOk = activeStatuses.size === 0 || activeStatuses.has(lp.status);
      if (!statusOk) return false;
      if (!searchText) return true;
      var hay = ((lp.loopName || '') + ' ' + (proj.projectDir || proj.projectId || '')).toLowerCase();
      return hay.indexOf(searchText) !== -1;
    }

    function sectionStatusClass(s) {
      return 'section-status section-' + s;
    }

    function parseLoopHash(hash) {
      var out = { projectId: null, loopName: null };
      var raw = (hash || '').replace(/^#/, '');
      if (!raw) return out;
      var slash = raw.indexOf('/');
      if (slash === -1) { out.projectId = decodeURIComponent(raw); return out; }
      out.projectId = decodeURIComponent(raw.slice(0, slash));
      var lp = raw.slice(slash + 1);
      out.loopName = lp ? decodeURIComponent(lp) : null;
      return out;
    }

    function buildLoopHash(projectId, loopName) {
      if (!projectId) return '';
      var h = '#' + encodeURIComponent(projectId);
      if (loopName) h += '/' + encodeURIComponent(loopName);
      return h;
    }

    var suppressHashChange = false;

    function syncHash() {
      var next = buildLoopHash(selectedProjectId, selectedLoopName);
      if (('#' + (location.hash || '').replace(/^#/, '')) !== ('#' + next.replace(/^#/, ''))) {
        suppressHashChange = true;
        location.hash = next;
      }
    }

    function navigate(projectId, loopName) {
      selectedProjectId = projectId;
      selectedLoopName = loopName;
      syncHash();
      render(lastData);
    }

    function render(data) {
      lastData = data;
      var mount = document.getElementById('forge-dashboard');
      if (!mount) return;
      mount.textContent = '';

      // Totals bar
      var totalsBar = document.getElementById('totals-bar');
      if (totalsBar) {
        totalsBar.textContent = '';
        var t = data.totals;
        var totalLabels = [
          ['Projects', t.projects],
          ['Loops', t.loops],
          ['Running', t.running],
          ['Completed', t.completed],
          ['Cancelled', t.cancelled],
          ['Errored', t.errored],
          ['Stalled', t.stalled],
        ];
        var statusKey = { Running:'running', Completed:'completed', Cancelled:'cancelled', Errored:'errored', Stalled:'stalled' };
        for (var i = 0; i < totalLabels.length; i++) {
          var label = totalLabels[i][0];
          var key = statusKey[label];
          var b = document.createElement('span');
          b.className = key ? 'badge badge-filter' + (activeStatuses.has(key) ? ' badge-active' : '') : 'badge';
          b.textContent = label + ': ' + totalLabels[i][1];
          if (key) {
            b.addEventListener('click', function(k){ return function(){
              if (activeStatuses.has(k)) activeStatuses.delete(k);
              else activeStatuses.add(k);
              render(data);
            }; }(key));
          }
          totalsBar.appendChild(b);
        }
      }

      // Timestamp
      var ts = document.getElementById('timestamp');
      if (ts) {
        ts.textContent = 'Last updated: ' + new Date(data.generatedAt).toLocaleString();
      }

      // Master-detail: sidebar of projects + detail pane for the selection.
      var matchedByProject = [];
      for (var p = 0; p < data.projects.length; p++) {
        var proj = data.projects[p];
        var matched = [];
        for (var l = 0; l < proj.loops.length; l++) {
          var dashLoop = proj.loops[l];
          if (loopMatchesFilters(dashLoop.loop, proj)) matched.push(dashLoop);
        }
        if (matched.length > 0) matchedByProject.push({ proj: proj, loops: matched });
      }

      if (matchedByProject.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No loops match the current filters.';
        mount.appendChild(empty);
        return;
      }

      var selectedEntry = null;
      for (var si = 0; si < matchedByProject.length; si++) {
        if (matchedByProject[si].proj.projectId === selectedProjectId) {
          selectedEntry = matchedByProject[si];
          break;
        }
      }
      if (!selectedEntry) {
        selectedEntry = matchedByProject[0];
        selectedProjectId = selectedEntry.proj.projectId;
        selectedLoopName = null;
      }

      var activeLoop = null;
      if (selectedLoopName) {
        for (var k = 0; k < selectedEntry.loops.length; k++) {
          if (selectedEntry.loops[k].loop.loopName === selectedLoopName) { activeLoop = selectedEntry.loops[k]; break; }
        }
        if (!activeLoop) { selectedLoopName = null; }
      }

      var layout = document.createElement('div');
      layout.className = 'dash-layout';

      var sidebar = document.createElement('div');
      sidebar.className = 'project-sidebar';
      for (var ni = 0; ni < matchedByProject.length; ni++) {
        var entry = matchedByProject[ni];
        var navItem = document.createElement('div');
        navItem.className = 'project-nav-item' + (entry.proj.projectId === selectedProjectId ? ' selected' : '');

        var hasRunning = false;
        for (var ri = 0; ri < entry.loops.length; ri++) {
          if (entry.loops[ri].loop.status === 'running') { hasRunning = true; break; }
        }
        if (hasRunning) {
          var dot = document.createElement('span');
          dot.className = 'project-nav-running';
          navItem.appendChild(dot);
        }

        var navName = document.createElement('span');
        navName.className = 'project-nav-name';
        var rawPath = entry.proj.projectDir || entry.proj.projectId || '';
        var rawSegments = rawPath.split('/').filter(Boolean);
        navName.textContent = rawSegments.length ? rawSegments[rawSegments.length - 1] : rawPath;
        navName.title = rawPath;
        navItem.appendChild(navName);

        var navCount = document.createElement('span');
        navCount.className = 'project-nav-count';
        navCount.textContent = String(entry.loops.length);
        navItem.appendChild(navCount);

        navItem.addEventListener('click', function(pid) {
          return function() { navigate(pid, null); };
        }(entry.proj.projectId));

        sidebar.appendChild(navItem);
      }
      layout.appendChild(sidebar);

      var detailPane = document.createElement('div');
      detailPane.className = 'project-detail';

      var projEl = document.createElement('div');
      projEl.className = 'project';

      var header = document.createElement('div');
      header.className = 'project-header';
      header.textContent = selectedEntry.proj.projectDir || selectedEntry.proj.projectId;
      projEl.appendChild(header);

      if (activeLoop) {
        projEl.appendChild(buildLoopDetail(activeLoop));
      } else {
        for (var dl = 0; dl < selectedEntry.loops.length; dl++) {
          projEl.appendChild(buildLoopRow(selectedEntry.loops[dl]));
        }
      }

      detailPane.appendChild(projEl);
      layout.appendChild(detailPane);
      mount.appendChild(layout);

      syncHash();
    }

    function appendLoopSummary(dashLoop, badgeTarget, infoTarget) {
      var lp = dashLoop.loop;

      var badge = document.createElement('span');
      badge.className = statusClass(lp.status);
      badge.textContent = lp.status;
      badgeTarget.appendChild(badge);

      var nameStrong = document.createElement('strong');
      nameStrong.textContent = lp.loopName;
      infoTarget.appendChild(nameStrong);

      var infoParts = [
        fmtTime(lp.startedAt),
        'phase: ' + lp.phase,
        'iteration ' + lp.iteration + '/' + lp.maxIterations,
        'section ' + lp.currentSectionIndex + '/' + lp.totalSections,
      ];
      if (dashLoop.duration) infoParts.push(dashLoop.duration);
      infoTarget.appendChild(document.createTextNode(' — ' + infoParts.join(', ')));
      if (lp.status !== 'running' && lp.completedAt) {
        infoTarget.appendChild(document.createTextNode(' — '));
        var doneSpan = document.createElement('span');
        doneSpan.className = 'dim';
        doneSpan.textContent = 'done: ' + fmtTime(lp.completedAt);
        infoTarget.appendChild(doneSpan);
      }

      if (lp.terminationReason) {
        infoTarget.appendChild(document.createTextNode(' — '));
        var termSpan = document.createElement('span');
        termSpan.className = 'error-text';
        termSpan.textContent = lp.terminationReason;
        infoTarget.appendChild(termSpan);
      }
    }

    function buildLoopRow(dashLoop) {
      var loopRow = document.createElement('div');
      loopRow.className = 'loop-row';

      var info = document.createElement('span');
      info.className = 'loop-info';

      appendLoopSummary(dashLoop, loopRow, info);

      loopRow.appendChild(info);

      loopRow.addEventListener('click', function(name) {
        return function() { navigate(selectedProjectId, name); };
      }(dashLoop.loop.loopName));

      return loopRow;
    }

    // Cache of rendered markdown sections, keyed by loop name + section label.
    // Reusing the live wrapper element across renders avoids re-parsing
    // unchanged markdown and preserves the user's scroll position.
    var markdownCache = {};

    function appendMarkdownSection(parent, cacheKey, label, src) {
      if (!src) return;
      var title = document.createElement('h4');
      title.className = 'section-label';
      title.textContent = label;
      parent.appendChild(title);

      var cached = markdownCache[cacheKey];
      if (cached && cached.src === src) {
        parent.appendChild(cached.wrap);
        return;
      }

      var wrap = document.createElement('div');
      wrap.className = 'markdown-scrollable';
      var content = document.createElement('div');
      content.className = 'markdown-content';
      content.innerHTML = marked.parse(src);
      wrap.appendChild(content);
      parent.appendChild(wrap);

      markdownCache[cacheKey] = { src: src, wrap: wrap };
    }

    function buildLoopDetail(dashLoop) {
      var lp = dashLoop.loop;

      var loopEl = document.createElement('div');
      loopEl.className = 'loop';

      // Back to loops
      var backEl = document.createElement('div');
      backEl.className = 'back-to-loops';
      backEl.textContent = '← Back to loops';
      backEl.addEventListener('click', function() { navigate(selectedProjectId, null); });
      loopEl.appendChild(backEl);

      // Loop detail header
      var detailHeader = document.createElement('div');
      detailHeader.className = 'loop-detail-header';

      appendLoopSummary(dashLoop, detailHeader, detailHeader);

      loopEl.appendChild(detailHeader);

      // Detail body
      var detail = document.createElement('div');
      detail.className = 'loop-detail';

      var mdKey = lp.loopName + '::';

      // Completion summary (markdown)
      appendMarkdownSection(detail, mdKey + 'completionSummary', 'Completion Summary', lp.completionSummary);

      // Sections
      if (dashLoop.sections && dashLoop.sections.length > 0) {
        var secTitle = document.createElement('h4');
        secTitle.textContent = 'Sections';
        detail.appendChild(secTitle);
        for (var s = 0; s < dashLoop.sections.length; s++) {
          var sec = dashLoop.sections[s];
          var secRow = document.createElement('div');
          secRow.className = 'section-row';
          var secBadge = document.createElement('span');
          secBadge.className = sectionStatusClass(sec.status);
          secBadge.textContent = sec.status;
          secRow.appendChild(secBadge);
          var secLabel = document.createElement('span');
          secLabel.textContent = '#' + sec.sectionIndex + ' ' + sec.title + ' (attempts: ' + sec.attempts + ')';
          secRow.appendChild(secLabel);
          detail.appendChild(secRow);
        }
      }

      // Findings (resizable)
      if (dashLoop.findings && dashLoop.findings.length > 0) {
        var fTitle = document.createElement('h4');
        fTitle.textContent = 'Findings (' + dashLoop.findings.length + ')';
        detail.appendChild(fTitle);

        var findingsBlock = document.createElement('div');
        findingsBlock.className = 'resizable-block';

        // Group by severity
        var bugs = [];
        var warnings = [];
        for (var f = 0; f < dashLoop.findings.length; f++) {
          var finding = dashLoop.findings[f];
          if (finding.severity === 'bug') bugs.push(finding);
          else warnings.push(finding);
        }

        if (bugs.length > 0) {
          var bugsTitle = document.createElement('div');
          bugsTitle.className = 'finding finding-bug';
          bugsTitle.textContent = 'Bugs:';
          findingsBlock.appendChild(bugsTitle);
          for (var fb = 0; fb < bugs.length; fb++) {
            var bEl = document.createElement('div');
            bEl.className = 'finding finding-bug';
            bEl.textContent = bugs[fb].file + ':' + bugs[fb].line + ' — ' + bugs[fb].description;
            if (bugs[fb].scenario) {
              bEl.textContent += ' (' + bugs[fb].scenario + ')';
            }
            findingsBlock.appendChild(bEl);
          }
        }

        if (warnings.length > 0) {
          var wTitle = document.createElement('div');
          wTitle.className = 'finding finding-warning';
          wTitle.textContent = 'Warnings:';
          findingsBlock.appendChild(wTitle);
          for (var fw = 0; fw < warnings.length; fw++) {
            var wEl = document.createElement('div');
            wEl.className = 'finding finding-warning';
            wEl.textContent = warnings[fw].file + ':' + warnings[fw].line + ' — ' + warnings[fw].description;
            if (warnings[fw].scenario) {
              wEl.textContent += ' (' + warnings[fw].scenario + ')';
            }
            findingsBlock.appendChild(wEl);
          }
        }

        detail.appendChild(findingsBlock);
      }

      // Usage
      if (dashLoop.usage) {
        var u = dashLoop.usage;
        var uTitle = document.createElement('h4');
        uTitle.textContent = 'Usage';
        detail.appendChild(uTitle);

        var totalRow = document.createElement('div');
        totalRow.className = 'usage-row';
        totalRow.textContent = 'Total cost: $' + u.totalCost.toFixed(6) + ', tokens: ' + u.totalInputTokens + ' in / ' + u.totalOutputTokens + ' out (reasoning: ' + u.totalReasoningTokens + ', cache R: ' + u.totalCacheReadTokens + ' W: ' + u.totalCacheWriteTokens + '), messages: ' + u.totalMessageCount;
        detail.appendChild(totalRow);

        var modelKeys = Object.keys(u.byModel);
        if (modelKeys.length > 0) {
          for (var mk = 0; mk < modelKeys.length; mk++) {
            var model = modelKeys[mk];
            var m = u.byModel[model];
            var modelRow = document.createElement('div');
            modelRow.className = 'usage-row';
            modelRow.textContent = '  ' + model + ': $' + m.cost.toFixed(6) + ', ' + m.inputTokens + ' in / ' + m.outputTokens + ' out (reasoning: ' + m.reasoningTokens + ', cache R: ' + m.cacheReadTokens + ' W: ' + m.cacheWriteTokens + '), messages: ' + m.messageCount;
            detail.appendChild(modelRow);
          }
        }
      }

      // Last audit result (markdown)
      appendMarkdownSection(detail, mdKey + 'lastAuditResult', 'Last Audit Result', dashLoop.lastAuditResult);

      // Plan (markdown)
      appendMarkdownSection(detail, mdKey + 'plan', 'Plan', dashLoop.plan);

      loopEl.appendChild(detail);
      return loopEl;
    }

    var searchEl = document.getElementById('loop-search');
    if (searchEl) {
      searchEl.addEventListener('input', function() {
        searchText = (searchEl.value || '').trim().toLowerCase();
        lastData && render(lastData);
      });
    }

    window.addEventListener('hashchange', function() {
      if (suppressHashChange) { suppressHashChange = false; return; }
      var parsed = parseLoopHash(location.hash);
      selectedProjectId = parsed.projectId;
      selectedLoopName = parsed.loopName;
      if (lastData) render(lastData);
    });

    // Initial load + poll
    var initial = parseLoopHash(location.hash);
    if (initial.projectId) selectedProjectId = initial.projectId;
    if (initial.loopName) selectedLoopName = initial.loopName;
    load();
    setInterval(load, 5000);
  })();
</script>
</body>
</html>`
}
