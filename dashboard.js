/**
 * Clinic Command Center · dashboard.js
 * ─────────────────────────────────────────────────────────
 * NOTE: Add these lines to server.js (after the existing app.get("/") line):
 *
 *   const LEADS_FILE = path.join(__dirname, 'leads.json');
 *
 *   app.get('/api/leads', (_req, res) => {
 *     try {
 *       const data = fs.existsSync(LEADS_FILE)
 *         ? JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'))
 *         : [];
 *       res.json(Array.isArray(data) ? data : []);
 *     } catch { res.json([]); }
 *   });
 *
 * And inside pushLeadToSheets(), persist to leads.json:
 *
 *   const leadsArr = fs.existsSync(LEADS_FILE)
 *     ? JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')) : [];
 *   leadsArr.push({ ...lead, timestamp: new Date().toISOString(), completed: true });
 *   fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsArr, null, 2));
 * ─────────────────────────────────────────────────────────
 */

'use strict';

/* ── Config ──────────────────────────────────────────────── */
const API          = '/api/leads';
const POLL_MS      = 30_000;
const CHART_COLORS = ['#10b981','#3b82f6','#f59e0b','#8b5cf6','#f43f5e','#06b6d4','#ec4899'];

/* ── State ───────────────────────────────────────────────── */
let ALL        = [];   // raw normalised leads
let FILTERED   = [];   // after filters
let pollTimer  = null;
let chartRange = 7;
let charts     = {};   // keyed by canvas id

/* ── DOM shortcuts ───────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };

/* ═══════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════ */
function getTheme() { return document.documentElement.dataset.theme || 'dark'; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('clinic_theme', t);
  const dark = t === 'dark';
  $('themeIconSun').style.display  = dark ? '' : 'none';
  $('themeIconMoon').style.display = dark ? 'none' : '';
  $('themeLabel').textContent = dark ? 'Light Mode' : 'Dark Mode';
  // rebuild charts after CSS vars update
  setTimeout(() => { if (ALL.length) { renderAllCharts(); } }, 60);
}
function toggleTheme() { applyTheme(getTheme() === 'dark' ? 'light' : 'dark'); }

// Init theme
(function() {
  const saved = localStorage.getItem('clinic_theme');
  applyTheme(saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
})();

$('themeBtn')?.addEventListener('click', toggleTheme);
$('settingsThemeBtn')?.addEventListener('click', toggleTheme);

/* ═══════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════ */
const PAGE_META = {
  overview:  { title: 'Overview',  breadcrumb: 'Dashboard / Overview'  },
  leads:     { title: 'Leads',     breadcrumb: 'Dashboard / Leads'     },
  analytics: { title: 'Analytics', breadcrumb: 'Dashboard / Analytics' },
  settings:  { title: 'Settings',  breadcrumb: 'Dashboard / Settings'  },
};

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const pg = $(`page-${name}`);
  if (pg) pg.classList.add('active');
  document.querySelectorAll(`[data-page="${name}"]`).forEach(i => i.classList.add('active'));
  const meta = PAGE_META[name] || {};
  if ($('headerTitle'))     $('headerTitle').textContent     = meta.title || name;
  if ($('headerBreadcrumb')) $('headerBreadcrumb').textContent = meta.breadcrumb || '';
  closeMobileSidebar();
  if (name === 'leads')     applyFilters();
  if (name === 'analytics') setTimeout(renderAnalyticsCharts, 80);
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    showPage(el.dataset.page);
  });
});

/* ═══════════════════════════════════════════════════════════
   MOBILE SIDEBAR
   ═══════════════════════════════════════════════════════════ */
function closeMobileSidebar() {
  $('sidebar').classList.remove('open');
  $('mobOverlay').classList.remove('show');
}
$('hamBtn')?.addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
  $('mobOverlay').classList.toggle('show');
});
$('mobOverlay')?.addEventListener('click', closeMobileSidebar);

/* ═══════════════════════════════════════════════════════════
   DATA FETCHING
   ═══════════════════════════════════════════════════════════ */
async function fetchLeads() {
  try {
    const r = await fetch(API);
    if (!r.ok) throw new Error(`${r.status}`);
    const d = await r.json();
    return Array.isArray(d) ? d.map(normalise) : [];
  } catch (e) {
    console.warn('[Clinic Dashboard] fetch error:', e.message);
    return [];
  }
}

function normalise(l) {
  return {
    name:      l.name       || '—',
    phone:     l.phone      || '—',
    service:   l.service    || '—',
    notes:     l.notes      || '',
    timestamp: l.timestamp  || l.Timestamp || null,
    duration:  l.duration   || l.callDuration || null,
    completed: l.completed !== undefined ? Boolean(l.completed) : !!(l.name && l.phone),
  };
}

async function loadData() {
  showRefreshSpin(true);
  ALL = await fetchLeads();
  showRefreshSpin(false);

  hideSkelRows();
  renderStats();
  renderRecentTable();
  renderAllCharts();
  populateServiceFilter();
  applyFilters();
  updateBadge();

  const now = new Date();
  if ($('lastSync')) $('lastSync').textContent = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}

function showRefreshSpin(on) {
  [$('refreshBtn'), $('topRefreshBtn')].forEach(b => {
    if (!b) return;
    b.classList.toggle('spinning', on);
  });
}
function hideSkelRows() {
  const s = $('skelRows');
  if (s) { s.style.display = 'none'; }
}

/* ═══════════════════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════════════════ */
function renderStats() {
  const total    = ALL.length;
  const done     = ALL.filter(l => l.completed).length;
  const todayStr = new Date().toDateString();
  const today    = ALL.filter(l => l.timestamp && new Date(l.timestamp).toDateString() === todayStr).length;
  const dropPct  = total ? Math.round(((total - done) / total) * 100) : 0;
  const donePct  = total ? Math.round((done / total) * 100) : 0;
  const durs     = ALL.map(l => parseDur(l.duration)).filter(d => d > 0);
  const avgDur   = durs.length ? Math.round(durs.reduce((a,b)=>a+b,0)/durs.length) : 0;

  setText('svTotal',    total     || '0');
  setText('svCompleted', done     || '0');
  setText('svAvgDur',   avgDur    ? fmtDur(avgDur) : '—');
  setText('svDropoff',  total     ? dropPct + '%'  : '—');
  setText('svToday',    today     || '0');

  setWidth('barTotal',     Math.min(100, total     * 4));
  setWidth('barCompleted', donePct);
  setWidth('barAvgDur',    Math.min(100, (avgDur / 300) * 100));
  setWidth('barDropoff',   dropPct);
  setWidth('barToday',     Math.min(100, today     * 10));

  // deltas (vs yesterday)
  const yestStr = new Date(Date.now() - 86400000).toDateString();
  const yest    = ALL.filter(l => l.timestamp && new Date(l.timestamp).toDateString() === yestStr).length;
  const diff    = today - yest;
  setText('deltaToday', (diff >= 0 ? '+' : '') + diff + ' vs yesterday');
  $('deltaToday').className = 'stat-delta ' + (diff >= 0 ? 'pos' : 'neg');
  setText('deltaCompleted', donePct + '%');
  setText('deltaTotalLeads', '+' + total);
  setText('deltaDropoff', dropPct + '%');
  setText('deltaAvgDur', avgDur ? fmtDur(avgDur) : '—');
}

function setText(id, val) { const e = $(id); if (e) e.textContent = val; }
function setWidth(id, pct) {
  const e = $(id);
  if (e) { e.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
}

/* ═══════════════════════════════════════════════════════════
   RECENT TABLE (overview)
   ═══════════════════════════════════════════════════════════ */
function renderRecentTable() {
  const tbody = $('recentBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const recent = [...ALL].sort(sortByTime).slice(0, 10);
  if (!recent.length) {
    if ($('recentEmpty')) $('recentEmpty').style.display = 'flex';
    return;
  }
  if ($('recentEmpty')) $('recentEmpty').style.display = 'none';
  recent.forEach(l => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-name">${esc(l.name)}</td>
      <td class="td-phone">${esc(l.phone)}</td>
      <td class="td-service">${esc(l.service)}</td>
      <td class="td-dur">${l.duration ? fmtDur(parseDur(l.duration)) : '—'}</td>
      <td>${chipHtml(l.completed)}</td>
      <td class="td-ts">${l.timestamp ? fmtDT(l.timestamp) : '—'}</td>
    `;
    tr.addEventListener('click', () => openModal(l));
    tbody.appendChild(tr);
  });
}

/* ═══════════════════════════════════════════════════════════
   LEADS TABLE (full)
   ═══════════════════════════════════════════════════════════ */
function populateServiceFilter() {
  const sel  = $('fService');
  if (!sel) return;
  const svcs = [...new Set(ALL.map(l => l.service).filter(s => s && s !== '—'))].sort();
  // keep "All services" option, replace rest
  while (sel.options.length > 1) sel.remove(1);
  svcs.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s; sel.appendChild(o);
  });
}

function applyFilters() {
  const from    = $('fFrom')?.value;
  const to      = $('fTo')?.value;
  const service = $('fService')?.value;
  const status  = $('fStatus')?.value;
  const search  = $('searchInput')?.value?.toLowerCase() || '';

  FILTERED = ALL.filter(l => {
    if (from && l.timestamp && new Date(l.timestamp) < new Date(from))               return false;
    if (to   && l.timestamp && new Date(l.timestamp) > new Date(to + 'T23:59:59'))   return false;
    if (service && l.service !== service)                                              return false;
    if (status === '1' && !l.completed)  return false;
    if (status === '0' &&  l.completed)  return false;
    if (search && !`${l.name} ${l.phone} ${l.service}`.toLowerCase().includes(search)) return false;
    return true;
  }).sort(sortByTime);

  renderFullTable();
  if ($('resultCount')) $('resultCount').textContent = `${FILTERED.length} lead${FILTERED.length !== 1 ? 's' : ''}`;
}

function renderFullTable() {
  const tbody = $('leadsBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!FILTERED.length) {
    if ($('leadsEmpty'))  $('leadsEmpty').style.display  = 'flex';
    if ($('leadsTable'))  $('leadsTable').style.display  = 'none';
    return;
  }
  if ($('leadsEmpty'))  $('leadsEmpty').style.display  = 'none';
  if ($('leadsTable'))  $('leadsTable').style.display  = '';

  FILTERED.forEach((l, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-num">${i + 1}</td>
      <td class="td-name">${esc(l.name)}</td>
      <td class="td-phone">${esc(l.phone)}</td>
      <td class="td-service">${esc(l.service)}</td>
      <td class="td-dur">${l.duration ? fmtDur(parseDur(l.duration)) : '—'}</td>
      <td>${chipHtml(l.completed)}</td>
      <td class="td-ts">${l.timestamp ? fmtDT(l.timestamp) : '—'}</td>
      <td><button class="view-btn">View</button></td>
    `;
    tr.querySelector('.view-btn').addEventListener('click', e => { e.stopPropagation(); openModal(l); });
    tr.addEventListener('click', () => openModal(l));
    tbody.appendChild(tr);
  });
}

// Filter events
['fFrom','fTo','fService','fStatus'].forEach(id => $$(id,'change', applyFilters));
$('searchInput')?.addEventListener('input', debounce(applyFilters, 220));
$('clearFilters')?.addEventListener('click', () => {
  ['fFrom','fTo','fService','fStatus'].forEach(id => { const e=$(id); if(e) e.value=''; });
  applyFilters();
});

/* ═══════════════════════════════════════════════════════════
   CSV EXPORT
   ═══════════════════════════════════════════════════════════ */
$('csvBtn')?.addEventListener('click', () => {
  const rows = [['Name','Phone','Service','Notes','Timestamp','Duration','Completed']];
  FILTERED.forEach(l => rows.push([l.name, l.phone, l.service, l.notes, l.timestamp||'', l.duration||'', l.completed?'Yes':'No']));
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const clinicSlug = (window.CLINIC?.name || 'clinic').replace(/\s+/g, '-');
  a.download = `${clinicSlug}-leads-${fmtDateFile(new Date())}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
});

/* ═══════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════ */
function openModal(l) {
  setText('mName',       l.name);
  setText('mPhone',      l.phone);
  setText('mService',    l.service);
  setText('mDuration',   l.duration ? fmtDur(parseDur(l.duration)) : '—');
  setText('mTimestamp',  l.timestamp ? fmtDT(l.timestamp) : '—');
  setText('mNotes',      l.notes || 'No notes recorded.');
  $('mBadgeRow').innerHTML = chipHtml(l.completed);
  $('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}
$('modalClose')?.addEventListener('click',  closeModal);
$('modalOverlay')?.addEventListener('click', e => { if(e.target === $('modalOverlay')) closeModal(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });

// Export PDF (print current modal content)
$('mExportPdf')?.addEventListener('click', () => window.print());

/* ═══════════════════════════════════════════════════════════
   CHARTS
   ═══════════════════════════════════════════════════════════ */
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function chartTheme() {
  return {
    text:    cssVar('--text-secondary'),
    muted:   cssVar('--text-muted'),
    grid:    cssVar('--border'),
    surface: cssVar('--bg-elevated'),
    tip: { bg: cssVar('--bg-elevated'), title: cssVar('--text-primary'), body: cssVar('--text-secondary'), border: cssVar('--border-med') }
  };
}

function destroyChart(id) { if(charts[id]) { charts[id].destroy(); delete charts[id]; } }

function tooltipStyle(t) {
  return {
    backgroundColor: t.tip.bg,
    titleColor:      t.tip.title,
    bodyColor:       t.tip.body,
    borderColor:     t.tip.border,
    borderWidth:     1,
    padding:         10,
    cornerRadius:    8,
    titleFont:       { family: "'Geist Mono'", size: 11 },
    bodyFont:        { family: "'Geist Mono'", size: 11 },
  };
}

function scaleStyle(t) {
  return {
    x: {
      grid:  { color: t.grid, drawBorder: false },
      ticks: { color: t.text, font: { family: "'Geist Mono'", size: 10 }, maxRotation: 0 },
    },
    y: {
      grid:  { color: t.grid, drawBorder: false },
      ticks: { color: t.text, font: { family: "'Geist Mono'", size: 10 }, stepSize: 1 },
      beginAtZero: true,
    },
  };
}

/* ── Time series ── */
function buildTimeSeries(days) {
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    buckets[fmtDateKey(d)] = 0;
  }
  ALL.forEach(l => {
    if (!l.timestamp) return;
    const k = fmtDateKey(new Date(l.timestamp));
    if (k in buckets) buckets[k]++;
  });
  return {
    labels: Object.keys(buckets).map(k => {
      const d = new Date(k);
      return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    }),
    data: Object.values(buckets),
  };
}

function makeLineChart(canvasId, days) {
  destroyChart(canvasId);
  const ctx = $(canvasId); if (!ctx) return;
  const t   = chartTheme();
  const { labels, data } = buildTimeSeries(days);
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Leads',
        data,
        borderColor: '#10b981',
        backgroundColor: hexAlpha('#10b981', .08),
        pointBackgroundColor: '#10b981',
        pointBorderColor: cssVar('--bg-surface'),
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 7,
        borderWidth: 2,
        fill: true,
        tension: .42,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display:false }, tooltip: tooltipStyle(t) },
      scales: scaleStyle(t),
    },
  });
}

/* ── Donut ── */
function makeDonutChart(canvasId) {
  destroyChart(canvasId);
  const ctx = $(canvasId); if (!ctx) return;
  const t   = chartTheme();
  const counts = {};
  ALL.forEach(l => {
    const s = (l.service && l.service !== '—') ? l.service : 'Unknown';
    counts[s] = (counts[s]||0) + 1;
  });
  const sorted  = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,7);
  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: sorted.map(([k]) => k.length>20 ? k.slice(0,18)+'…' : k),
      datasets: [{
        data: sorted.map(([,v])=>v),
        backgroundColor: CHART_COLORS.map(c => hexAlpha(c, .8)),
        borderColor: cssVar('--bg-surface'),
        borderWidth: 3,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: t.text, font: { family:"'Geist Mono'", size:10 }, padding:14, boxWidth:10, boxHeight:10, usePointStyle: true },
        },
        tooltip: tooltipStyle(t),
      },
    },
  });
}

/* ── Completion bar ── */
function makeCompletionChart(canvasId) {
  destroyChart(canvasId);
  const ctx = $(canvasId); if (!ctx) return;
  const t   = chartTheme();

  // Group by ISO week
  const weeks = {};
  ALL.forEach(l => {
    if (!l.timestamp) return;
    const d   = new Date(l.timestamp);
    const wk  = isoWeek(d);
    if (!weeks[wk]) weeks[wk] = { done:0, drop:0 };
    l.completed ? weeks[wk].done++ : weeks[wk].drop++;
  });
  const sorted = Object.entries(weeks).sort(([a],[b])=>a.localeCompare(b)).slice(-8);
  const labels = sorted.map(([k]) => 'Wk ' + k.split('-W')[1]);

  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Completed', data: sorted.map(([,v])=>v.done), backgroundColor: hexAlpha('#10b981',.7), borderRadius: 4, borderSkipped: false },
        { label: 'Dropped',   data: sorted.map(([,v])=>v.drop), backgroundColor: hexAlpha('#f43f5e',.7), borderRadius: 4, borderSkipped: false },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: t.text, font: { family:"'Geist Mono'", size:10 }, boxWidth:10, boxHeight:10, usePointStyle:true } },
        tooltip: tooltipStyle(t),
      },
      scales: { ...scaleStyle(t), x: { ...scaleStyle(t).x, stacked: false } },
    },
  });
}

/* ── Hourly ── */
function makeHourlyChart(canvasId) {
  destroyChart(canvasId);
  const ctx = $(canvasId); if (!ctx) return;
  const t   = chartTheme();
  const hrs = new Array(24).fill(0);
  ALL.forEach(l => {
    if (!l.timestamp) return;
    hrs[new Date(l.timestamp).getHours()]++;
  });
  const labels = Array.from({length:24}, (_,i) => i === 0 ? '12a' : i < 12 ? `${i}a` : i === 12 ? '12p' : `${i-12}p`);
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Calls',
        data: hrs,
        backgroundColor: CHART_COLORS.map((c, i) => hexAlpha(CHART_COLORS[i % CHART_COLORS.length], .65)),
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display:false }, tooltip: tooltipStyle(t) },
      scales: scaleStyle(t),
    },
  });
}

function renderAllCharts() {
  makeLineChart('cLeadsTime', chartRange);
  makeDonutChart('cServices');
  makeCompletionChart('cCompletion');
}

function renderAnalyticsCharts() {
  makeLineChart('cAnalyticsTime', 30);
  makeDonutChart('cAnalyticsServices');
  makeHourlyChart('cHourly');
  makeCompletionChart('cAnalyticsCompletion');
}

// Range tabs
document.querySelectorAll('.rtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartRange = parseInt(btn.dataset.d, 10);
    makeLineChart('cLeadsTime', chartRange);
  });
});

/* ═══════════════════════════════════════════════════════════
   BADGE + REFRESH
   ═══════════════════════════════════════════════════════════ */
function updateBadge() {
  const b = $('sbBadge');
  if (b) b.textContent = ALL.length;
}

$('refreshBtn')?.addEventListener('click', loadData);
$('topRefreshBtn')?.addEventListener('click', loadData);

$('refreshInterval')?.addEventListener('change', function() {
  const ms = parseInt(this.value, 10);
  clearInterval(pollTimer);
  if (ms > 0) pollTimer = setInterval(loadData, ms);
});

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function chipHtml(done) {
  return done
    ? `<span class="chip complete">Completed</span>`
    : `<span class="chip dropped">Dropped</span>`;
}
function parseDur(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const m = String(v).match(/(?:(\d+)m\s*)?(\d+)?s?/);
  return (parseInt(m?.[1]||0)*60) + parseInt(m?.[2]||0);
}
function fmtDur(s) {
  if (!s) return '—';
  const m = Math.floor(s/60), sec = s%60;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}
function fmtDT(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) + ' ' +
         d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}
function fmtDateKey(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function fmtDateFile(d) { return fmtDateKey(d); }
function hexAlpha(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y   = t.getUTCFullYear();
  const wk  = Math.ceil(((t - new Date(Date.UTC(y,0,1)))/86400000 + 1)/7);
  return `${y}-W${String(wk).padStart(2,'0')}`;
}
function sortByTime(a,b) { return (b.timestamp||'') > (a.timestamp||'') ? 1 : -1; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }
function $$(id, ev, fn) { const e=$(id); if(e) e.addEventListener(ev, fn); }

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
loadData();
pollTimer = setInterval(loadData, POLL_MS);
