'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  me: { loggedIn: false },
  rates: null,
  stats: null,
  income: [],
  chartRaw: null,
  range: 'month',
  cur: localStorage.getItem('cur') || 'USD',
  charts: {},
};

// used only if the live rate endpoint is down (clearly flagged to the user)
const FALLBACK_RATES = { USD: 1, GBP: 0.79, PLN: 3.7, USDT_USD: 1, TRX_USD: 0.25, tax: { tradingAllowanceGBP: 1000, personalAllowanceGBP: 12570 } };

// ---------- formatting ----------
const money = (usd, cur = S.cur) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(usd * S.rates[cur]);
const usdt = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
const num = (n) => Math.round(n || 0).toLocaleString('en-US');
const pct = (x) => `${((x || 0) * 100).toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toUsd = (usdtAmount) => usdtAmount * S.rates.USDT_USD;
const engagement = (v) => (v.views ? (v.likes + v.comments + v.shares) / v.views : 0);

// ---------- helpers ----------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 3500);
}

function draw(id, type, labels, datasets) {
  S.charts[id]?.destroy();
  const grid = { color: 'rgba(255,255,255,.06)' };
  const ticks = { color: '#777' };
  S.charts[id] = new Chart($('#' + id), {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#111', borderColor: '#333', borderWidth: 1, titleColor: '#fff', bodyColor: '#ddd' },
      },
      scales: { x: { grid, ticks }, y: { grid, ticks, beginAtZero: true } },
    },
  });
}

// ---------- tabs ----------
function showTab(name) {
  if (!['overview', 'tiktok', 'csmafia'].includes(name)) name = 'overview';
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + name));
  $('#pageTitle').textContent = { overview: 'Overview', tiktok: 'TikTok Analytics', csmafia: 'CSMAFIA' }[name];
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}

// ---------- rendering ----------
function renderAll() {
  renderMe();
  renderOverview();
  renderTikTok();
  renderCalculator();
  renderIncome();
}

function renderMe() {
  const m = S.me;
  $('#loginBtn').textContent = m.loggedIn ? 'Log out' : 'Log in with TikTok';
  $('#sideUser').innerHTML = m.loggedIn
    ? `<img src="${esc(m.profile?.avatar_url)}" alt=""><div><b>${esc(m.profile?.display_name || 'Creator')}</b><small>@${esc(m.profile?.username || '')}</small></div>`
    : `<small>Not logged in</small>`;
  $('#gateOverview').hidden = m.loggedIn;
  $('#gateTiktok').hidden = m.loggedIn;
  $('#tiktokBody').hidden = !m.loggedIn;
  $('#gateIncome').hidden = m.loggedIn;
  $('#incomeBody').hidden = !m.loggedIn;
}

function renderOverview() {
  const s = S.stats;
  const hasData = S.me.loggedIn && s && s.totals.videos > 0;
  $('#overviewBody').hidden = !hasData;
  $('#overviewEmpty').hidden = !S.me.loggedIn || hasData;
  if (!hasData) return;

  const t = s.totals;
  const cards = [
    ['Views', num(t.views)], ['Likes', num(t.likes)], ['Comments', num(t.comments)], ['Shares', num(t.shares)],
    ['Followers', num(S.me.profile?.follower_count)], ['Engagement', pct(s.engagementRate)],
    ['Breakout rate', pct(s.breakout.rate)], ['Videos', num(t.videos)],
  ];
  $('#ovCards').innerHTML = cards.map(([k, v]) => `<div class="card stat"><span>${k}</span><b>${v}</b></div>`).join('');

  const asc = [...s.videos].reverse();
  draw('chartViews', 'bar', asc.map((v) => v.date), [{
    label: 'Views', data: asc.map((v) => v.views), backgroundColor: 'rgba(255,255,255,.85)', borderRadius: 6,
  }]);
  draw('chartWeekday', 'bar', s.byWeekday.map((d) => d.label), [{
    label: 'Median views', data: s.byWeekday.map((d) => d.median), backgroundColor: 'rgba(255,255,255,.5)', borderRadius: 6,
  }]);

  $('#topList').innerHTML = [...s.videos]
    .sort((a, b) => b.views - a.views)
    .slice(0, 5)
    .map((v, i) => `<li><div><b>${esc(v.title)}</b><small>${v.date} · ${num(v.views)} views · ${pct(engagement(v))} engagement</small></div><span class="rank">${i + 1}</span></li>`)
    .join('') || '<li class="muted">No videos</li>';

  $('#bestTimes').innerHTML = s.bestHours.length
    ? s.bestHours.map((h) => `<li><div><b>${h.label}</b><small>${h.count} videos</small></div><b>${num(h.median)} views</b></li>`).join('')
    : '<li class="muted">Not enough data yet</li>';
}

function renderTikTok() {
  const s = S.stats;
  $('#syncInfo').textContent = S.me.syncedAt ? `Last sync: ${new Date(S.me.syncedAt).toLocaleString()}` : 'Never synced';
  if (!s) return;
  $('#videoRows').innerHTML = s.videos.map((v) => `
    <tr>
      <td>${v.date}</td>
      <td class="title" title="${esc(v.title)}">${esc(v.title)}</td>
      <td class="r">${num(v.views)}</td>
      <td class="r">${num(v.likes)}</td>
      <td class="r">${num(v.comments)}</td>
      <td class="r">${num(v.shares)}</td>
      <td class="r">${pct(engagement(v))}</td>
      <td><span class="badge ${v.breakout ? 'hit' : ''}">${v.breakout ? 'Breakout' : '-'}</span></td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No videos synced yet</td></tr>';
}

function renderPrediction(p) {
  $('#predResult').hidden = false;
  $('#ring').style.setProperty('--p', p.chance);
  $('#ringValue').textContent = `${p.chance}%`;
  $('#predText').innerHTML = `
    <b>Breakout chance</b>
    <p class="muted small" style="margin:4px 0 8px">Chance of reaching ${num(p.breakoutThreshold)} views (2× your median)</p>
    <ul>
      <li>Expected views (median): <b>${num(p.expectedViews)}</b></li>
      <li>Based on ${p.sample} videos (${esc(p.basis)})</li>
      <li>Caption: ${esc(p.title || 'not detected, enter hashtags manually')}</li>
      <li>Hashtags used: ${p.hashtags}</li>
    </ul>
    ${p.own ? `<p class="muted small">This is one of your videos: ${num(p.own.views)} views so far.</p>` : ''}`;
}

function renderCalculator() {
  const r = S.rates;
  const v = Number($('#calcViews').value);
  const ok = Number.isFinite(v) && v >= 1000 && v <= 300000;
  $('#calcError').textContent = ok ? '' : 'Enter between 1,000 and 300,000 views';
  $('#calcResult').classList.toggle('dim', !ok);
  const usd = ok ? (v / 1000) * 0.75 : 0;
  $('#calcUsd').textContent = money(usd, 'USD');
  $('#calcGbp').textContent = money(usd, 'GBP');
  $('#calcPln').textContent = money(usd, 'PLN');
  $('#calcUsdt').textContent = usdt(usd / r.USDT_USD);
  $('#calcTrx').textContent = `${num(usd / r.TRX_USD)} TRX`;
}

function ukTaxYearStart(now) {
  // UK tax year runs 6 April to 5 April
  const y = now.getFullYear() - (now < new Date(now.getFullYear(), 3, 6) ? 1 : 0);
  return { year: y, start: `${y}-04-06` };
}

function renderIncome() {
  if (!S.me.loggedIn) return;
  const total = S.income.reduce((s, e) => s + e.usdt, 0);
  $('#incTotal').textContent = usdt(total);
  $('#incTotalLocal').textContent = money(toUsd(total));

  // UK tax: only income in the current tax year counts toward the allowances
  const { year, start } = ukTaxYearStart(new Date());
  const ytdUsdt = S.income.filter((e) => e.date >= start).reduce((s, e) => s + e.usdt, 0);
  const gbp = toUsd(ytdUsdt) * S.rates.GBP;
  const T = S.rates.tax;
  const gbpFmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

  $('#taxYear').textContent = `Tax year ${year}/${String(year + 1).slice(2)} (6 Apr – 5 Apr) · income so far: ${gbpFmt(gbp)}`;
  $('#taxLabel1').textContent = `Trading allowance (${gbpFmt(T.tradingAllowanceGBP)})`;
  $('#taxVal1').textContent = `${gbpFmt(gbp)} / ${gbpFmt(T.tradingAllowanceGBP)}`;
  $('#taxBar1').style.width = `${Math.min(100, (gbp / T.tradingAllowanceGBP) * 100)}%`;
  $('#taxLabel2').textContent = `Personal allowance (${gbpFmt(T.personalAllowanceGBP)})`;
  $('#taxVal2').textContent = `${gbpFmt(gbp)} / ${gbpFmt(T.personalAllowanceGBP)}`;
  $('#taxBar2').style.width = `${Math.min(100, (gbp / T.personalAllowanceGBP) * 100)}%`;

  const w = $('#taxWarning');
  const limit = T.tradingAllowanceGBP;
  if (gbp >= limit) {
    w.className = 'warn danger';
    w.textContent = `You are over the ${gbpFmt(limit)} trading allowance this tax year. Income above it normally has to be reported to HMRC through Self Assessment (register as self-employed by 5 October after the end of the tax year). Speak to an accountant.`;
  } else if (gbp >= limit * 0.8) {
    w.className = 'warn caution';
    w.textContent = `Warning: you are at ${pct(gbp / limit)} of the ${gbpFmt(limit)} trading allowance. Only ${gbpFmt(limit - gbp)} is left before you need to register with HMRC.`;
  } else {
    w.className = 'warn ok';
    w.textContent = `${gbpFmt(limit - gbp)} left before the ${gbpFmt(limit)} trading allowance is exceeded this tax year.`;
  }

  const rows = [...S.income].sort((a, b) => b.date.localeCompare(a.date));
  $('#incList').innerHTML = rows.map((e) => `
    <tr>
      <td>${e.date}</td>
      <td>${esc(e.note)}</td>
      <td class="r">${usdt(e.usdt)}</td>
      <td class="r">${money(toUsd(e.usdt))}</td>
      <td class="r"><button class="icon" data-del="${e.id}" aria-label="Delete">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No income entries yet</td></tr>';

  drawIncome();
}

function drawIncome() {
  if (!S.chartRaw) return;
  const values = S.chartRaw.values.map((v) => +(toUsd(v) * S.rates[S.cur]).toFixed(2));
  draw('chartIncome', 'line', S.chartRaw.labels, [{
    label: `Income (${S.cur})`,
    data: values,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,.08)',
    fill: true,
    tension: 0.35,
    pointRadius: 3,
    pointBackgroundColor: '#fff',
  }]);
}

async function loadIncomeChart() {
  if (!S.me.loggedIn) return;
  S.chartRaw = await api(`/api/income/chart?range=${S.range}`);
  drawIncome();
}

// ---------- actions ----------
async function loadAll() {
  S.me = await api('/api/me');
  S.rates = await api('/api/rates').catch(() => {
    toast('Live rates unavailable, showing approximate values', true);
    return FALLBACK_RATES;
  });
  if (S.me.loggedIn) {
    $('#profileUrl').value = S.me.profileUrl || '';
    const [inc, stats] = await Promise.all([api('/api/income'), api('/api/stats')]);
    S.income = inc.entries;
    S.stats = stats;
    await loadIncomeChart();
  } else {
    S.income = [];
    S.stats = null;
  }
  renderAll();
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
}

function wireUp() {
  $$('.nav').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  $('#loginBtn').onclick = () => (S.me.loggedIn ? logout() : (location.href = '/auth/tiktok'));

  $('#currency').value = S.cur;
  $('#currency').onchange = (e) => {
    S.cur = e.target.value;
    localStorage.setItem('cur', S.cur);
    renderAll();
  };

  // calculator (range slider and number input stay in sync)
  $('#calcRange').oninput = (e) => { $('#calcViews').value = e.target.value; renderCalculator(); };
  $('#calcViews').oninput = (e) => {
    const v = Number(e.target.value);
    if (v >= 1000 && v <= 300000) $('#calcRange').value = v;
    renderCalculator();
  };

  // profile + sync
  $('#profileForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/profile', { method: 'POST', body: { url: $('#profileUrl').value } });
      S.me = await api('/api/me');
      toast('Profile saved');
    } catch (err) { toast(err.message, true); }
  };
  $('#syncBtn').onclick = async () => {
    const btn = $('#syncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const r = await api('/api/sync', { method: 'POST' });
      S.stats = await api('/api/stats');
      S.me = await api('/api/me');
      renderAll();
      toast(`Synced ${r.count} videos`);
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; btn.textContent = 'Sync videos'; }
  };

  // breakout predictor
  $('#predForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const p = await api('/api/predict', { method: 'POST', body: { url: $('#videoUrl').value, hashtags: $('#predTags').value } });
      renderPrediction(p);
    } catch (err) { toast(err.message, true); }
  };

  // income
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  $('#incDate').value = today.toISOString().slice(0, 10);
  $('#incForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/income', { method: 'POST', body: { date: $('#incDate').value, usdt: Number($('#incAmount').value), note: $('#incNote').value } });
      $('#incAmount').value = '';
      $('#incNote').value = '';
      S.income = (await api('/api/income')).entries;
      renderIncome();
      await loadIncomeChart();
      toast('Income saved');
    } catch (err) { toast(err.message, true); }
  };
  $('#incList').onclick = async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    try {
      await api(`/api/income/${id}`, { method: 'DELETE' });
      S.income = S.income.filter((x) => x.id !== id);
      renderIncome();
      await loadIncomeChart();
    } catch (err) { toast(err.message, true); }
  };
  $$('[data-range]').forEach((b) => (b.onclick = async () => {
    S.range = b.dataset.range;
    $$('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
    try { await loadIncomeChart(); } catch (err) { toast(err.message, true); }
  }));
}

async function init() {
  wireUp();
  try {
    await loadAll();
  } catch (err) {
    toast(err.message, true);
    S.rates = S.rates || FALLBACK_RATES;
    renderAll();
  }
  renderCalculator();
  showTab(location.hash.slice(1) || 'overview');
}

init();
