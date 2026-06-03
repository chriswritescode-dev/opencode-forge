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
  .project-nav-running { width: 8px; height: 8px; border-radius: 50%; background: #1f6feb; flex: 0 0 8px; }
  .project { margin-bottom: 24px; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; background: #161b22; }
  .project-header { font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; color: #58a6ff; }
  .empty-state { padding: 24px; color: #8b949e; font-size: 0.9rem; text-align: center; }
  .loop {
    border: 1px solid #30363d; border-radius: 6px; margin-bottom: 8px;
    background: #0d1117; overflow: hidden;
  }
  .loop-header {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    cursor: pointer; user-select: none;
  }
  .loop-header:hover { background: #161b22; }
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
  .expand-icon { color: #484f58; font-size: 0.8rem; width: 16px; text-align: center; }
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
  pre { background: #0d1117; padding: 8px; border-radius: 4px; max-height: 200px; overflow: auto; font-size: 0.75rem; color: #8b949e; white-space: pre-wrap; word-break: break-word; border: 1px solid #30363d; margin-top: 4px; }
  .timestamp { font-size: 0.75rem; color: #484f58; margin-bottom: 12px; }
  .error-text { color: #f85149; }
  .dim { color: #484f58; }
</style>
</head>
<body>
  <h1>Forge Dashboard</h1>
  <div id="totals-bar" class="totals"></div>
  <input id="loop-search" class="search-input" type="text" placeholder="Filter by loop name or project…" autocomplete="off">
  <div id="timestamp" class="timestamp"></div>
  <div id="forge-dashboard"></div>
<script>
  (function(){
    var expanded = new Set();
    var activeStatuses = new Set();
    var searchText = '';
    var lastData = null;
    var selectedProjectId = null;

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

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
          return function() {
            selectedProjectId = pid;
            render(data);
          };
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

      for (var dl = 0; dl < selectedEntry.loops.length; dl++) {
        projEl.appendChild(buildLoopEl(data, selectedEntry.proj, selectedEntry.loops[dl]));
      }

      detailPane.appendChild(projEl);
      layout.appendChild(detailPane);
      mount.appendChild(layout);
    }

    function buildLoopEl(data, proj, dashLoop) {
      var lp = dashLoop.loop;
      var key = proj.projectId + '::' + lp.loopName;
      var isExpanded = expanded.has(key);

      var loopEl = document.createElement('div');
      loopEl.className = 'loop';

      // ── Header (clickable) ──
      var loopHeader = document.createElement('div');
      loopHeader.className = 'loop-header';

      var expandIcon = document.createElement('span');
      expandIcon.className = 'expand-icon';
      expandIcon.textContent = isExpanded ? '▼' : '▶';
      loopHeader.appendChild(expandIcon);

      var badge = document.createElement('span');
      badge.className = statusClass(lp.status);
      badge.textContent = lp.status;
      loopHeader.appendChild(badge);

      var info = document.createElement('span');
      info.className = 'loop-info';
      var nameStrong = document.createElement('strong');
      nameStrong.textContent = lp.loopName;
      info.appendChild(nameStrong);

      var infoParts = [];
      infoParts.push('phase: ' + lp.phase);
      infoParts.push('iteration ' + lp.iteration + '/' + lp.maxIterations);
      infoParts.push('section ' + lp.currentSectionIndex + '/' + lp.totalSections);

      var duration = formatDuration(lp);
      if (duration) infoParts.push(duration);

      info.appendChild(document.createTextNode(' — ' + infoParts.join(', ')));

      if (lp.terminationReason) {
        info.appendChild(document.createTextNode(' — '));
        var termSpan = document.createElement('span');
        termSpan.className = 'error-text';
        termSpan.textContent = lp.terminationReason;
        info.appendChild(termSpan);
      }

      loopHeader.appendChild(info);

      loopHeader.addEventListener('click', function(k) {
        return function() {
          if (expanded.has(k)) expanded.delete(k);
          else expanded.add(k);
          render(data);
        };
      }(key));

      loopEl.appendChild(loopHeader);

      // ── Detail (expanded) ──
      if (isExpanded) {
        var detail = document.createElement('div');
        detail.className = 'loop-detail';

        // Completion summary
        if (lp.completionSummary) {
          var cs = document.createElement('div');
          cs.textContent = lp.completionSummary;
          detail.appendChild(cs);
        }

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

        // Findings
        if (dashLoop.findings && dashLoop.findings.length > 0) {
          var fTitle = document.createElement('h4');
          fTitle.textContent = 'Findings (' + dashLoop.findings.length + ')';
          detail.appendChild(fTitle);

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
            detail.appendChild(bugsTitle);
            for (var fb = 0; fb < bugs.length; fb++) {
              var bEl = document.createElement('div');
              bEl.className = 'finding finding-bug';
              bEl.textContent = bugs[fb].file + ':' + bugs[fb].line + ' — ' + bugs[fb].description;
              if (bugs[fb].scenario) {
                bEl.textContent += ' (' + bugs[fb].scenario + ')';
              }
              detail.appendChild(bEl);
            }
          }

          if (warnings.length > 0) {
            var wTitle = document.createElement('div');
            wTitle.className = 'finding finding-warning';
            wTitle.textContent = 'Warnings:';
            detail.appendChild(wTitle);
            for (var fw = 0; fw < warnings.length; fw++) {
              var wEl = document.createElement('div');
              wEl.className = 'finding finding-warning';
              wEl.textContent = warnings[fw].file + ':' + warnings[fw].line + ' — ' + warnings[fw].description;
              if (warnings[fw].scenario) {
                wEl.textContent += ' (' + warnings[fw].scenario + ')';
              }
              detail.appendChild(wEl);
            }
          }
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

        // Last audit result
        if (dashLoop.lastAuditResult) {
          var laTitle = document.createElement('h4');
          laTitle.textContent = 'Last Audit Result';
          detail.appendChild(laTitle);
          var laPre = document.createElement('pre');
          laPre.textContent = dashLoop.lastAuditResult;
          detail.appendChild(laPre);
        }

        // Plan
        if (dashLoop.plan) {
          var planTitle = document.createElement('h4');
          planTitle.textContent = 'Plan';
          detail.appendChild(planTitle);
          var planPre = document.createElement('pre');
          planPre.textContent = dashLoop.plan;
          detail.appendChild(planPre);
        }

        loopEl.appendChild(detail);
      }

      return loopEl;
    }

    function formatDuration(lp) {
      var start = lp.startedAt;
      var end = lp.completedAt || Date.now();
      var ms = end - start;
      if (ms <= 0) return '';
      var seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + 's';
      var minutes = Math.floor(seconds / 60);
      seconds = seconds % 60;
      if (minutes < 60) return minutes + 'm ' + seconds + 's';
      var hours = Math.floor(minutes / 60);
      minutes = minutes % 60;
      return hours + 'h ' + minutes + 'm';
    }

    var searchEl = document.getElementById('loop-search');
    if (searchEl) {
      searchEl.addEventListener('input', function() {
        searchText = (searchEl.value || '').trim().toLowerCase();
        lastData && render(lastData);
      });
    }

    // Initial load + poll
    load();
    setInterval(load, 5000);
  })();
</script>
</body>
</html>`
}
