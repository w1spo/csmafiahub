'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET, DATA_FILE } = process.env;
const PORT = process.env.PORT || 3000;
const BASE = (PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = BASE.startsWith('https://');
const REDIRECT_URI = `${BASE}/auth/tiktok/callback`;
const SECRET = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DB_FILE = DATA_FILE || path.join(__dirname, 'data.json');
const SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const USER_INFO = '/v2/user/info/?fields=display_name,avatar_url,username,follower_count,likes_count,video_count';
const VIDEO_LIST = '/v2/video/list/?fields=id,title,duration,create_time,share_url,view_count,like_count,comment_count,share_count';
const TAX = { tradingAllowanceGBP: 1000, personalAllowanceGBP: 12570 }; // UK thresholds, edit if HMRC changes them
const BREAKOUT_MULTIPLIER = 2; // "breakout" = views >= 2x your median

if (!SESSION_SECRET) console.warn('SESSION_SECRET not set - sessions reset on every restart');

// ---------- tiny JSON store ----------
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* first run */ }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// ---------- helpers ----------
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const viewsOf = (v) => v.view_count || 0;
const hashtagCount = (t) => ((t || '').match(/#\S+/g) || []).length;
const breakoutLine = (vids) => Math.max(median(vids.map(viewsOf)) * BREAKOUT_MULTIPLIER, 1000);

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function makeSession(openId) {
  const p = Buffer.from(openId).toString('base64url');
  return `${p}.${sign(p)}`;
}
function sessionUser(req) {
  const [p, sig] = (readCookies(req).session || '').split('.');
  if (!p || !sig) return null;
  const good = sign(p);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  return Buffer.from(p, 'base64url').toString();
}
function auth(req, res, next) {
  const openId = sessionUser(req);
  if (!openId || !db.users[openId]) return res.status(401).json({ error: 'Not logged in' });
  req.openId = openId;
  req.user = db.users[openId];
  next();
}

// TikTok access token with automatic refresh
async function accessToken(openId) {
  const u = db.users[openId];
  if (Date.now() < u.tokens.expiresAt - 60_000) return u.tokens.access;
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: u.tokens.refresh,
    }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error('TikTok session expired - please log in again');
  u.tokens = { access: t.access_token, refresh: t.refresh_token || u.tokens.refresh, expiresAt: Date.now() + t.expires_in * 1000 };
  save();
  return u.tokens.access;
}

async function tiktok(openId, endpoint, body) {
  const r = await fetch(`https://open.tiktokapis.com${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await accessToken(openId)}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (j.error && j.error.code !== 'ok') throw new Error(`TikTok API: ${j.error.code} ${j.error.message}`);
  return j.data;
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- OAuth (TikTok Login Kit) ---
app.get('/auth/tiktok', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 10 * 60_000 });
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY, scope: SCOPES, response_type: 'code', redirect_uri: REDIRECT_URI, state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/?login=denied');
    if (!code || state !== readCookies(req).oauth_state) return res.status(400).send('Invalid OAuth state');

    const tr = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
        code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
      }),
    });
    const t = await tr.json();
    if (!t.access_token) throw new Error(JSON.stringify(t));

    const openId = t.open_id;
    db.users[openId] ??= { income: [], videos: [], profileUrl: null };
    db.users[openId].tokens = { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
    db.users[openId].profile = (await tiktok(openId, USER_INFO)).user;
    save();

    res.clearCookie('oauth_state');
    res.cookie('session', makeSession(openId), { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 30 * 864e5 });
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Login failed: ${e.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = db.users[sessionUser(req)];
  if (!u) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, profile: u.profile, profileUrl: u.profileUrl, syncedAt: u.syncedAt || null, videoCount: u.videos.length });
});

// --- TikTok profile + sync ---
app.post('/api/profile', auth, (req, res) => {
  const url = String(req.body.url || '').trim();
  const m = url.match(/tiktok\.com\/@([\w.]+)/i);
  if (!m) return res.status(400).json({ error: 'Paste a link like https://www.tiktok.com/@yourname' });
  const mine = (req.user.profile?.username || '').toLowerCase();
  if (m[1].toLowerCase() !== mine) {
    return res.status(400).json({ error: `The official TikTok API only gives access to the logged-in account (@${mine}).` });
  }
  req.user.profileUrl = url;
  save();
  res.json({ ok: true });
});

app.post('/api/sync', auth, async (req, res) => {
  try {
    const videos = [];
    let cursor = 0;
    let hasMore = true;
    while (hasMore && videos.length < 1000) {
      const d = await tiktok(req.openId, VIDEO_LIST, { max_count: 20, cursor });
      const batch = d.videos || [];
      videos.push(...batch);
      hasMore = Boolean(d.has_more) && batch.length > 0;
      cursor = d.cursor;
    }
    req.user.videos = videos;
    req.user.profile = (await tiktok(req.openId, USER_INFO)).user;
    req.user.syncedAt = Date.now();
    save();
    res.json({ ok: true, count: videos.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', auth, (req, res) => {
  const vids = req.user.videos;
  const thr = breakoutLine(vids);
  const sum = (k) => vids.reduce((s, v) => s + (v[k] || 0), 0);

  const weekdays = Array.from({ length: 7 }, () => []);
  const hours = Array.from({ length: 24 }, () => []);
  vids.forEach((v) => {
    if (!v.create_time) return;
    const d = new Date(v.create_time * 1000);
    weekdays[d.getUTCDay()].push(viewsOf(v));
    hours[d.getUTCHours()].push(viewsOf(v));
  });
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byWeekday = weekdays.map((a, i) => ({ label: names[i], median: Math.round(median(a)), count: a.length }));
  const bestHours = hours
    .map((a, h) => ({ label: `${String(h).padStart(2, '0')}:00 UTC`, median: Math.round(median(a)), count: a.length }))
    .filter((x) => x.count)
    .sort((a, b) => b.median - a.median)
    .slice(0, 3);

  const totalViews = sum('view_count');
  const interactions = sum('like_count') + sum('comment_count') + sum('share_count');
  const broke = vids.filter((v) => viewsOf(v) >= thr).length;

  const videos = [...vids]
    .sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
    .map((v) => ({
      id: v.id,
      title: v.title || '(no caption)',
      date: v.create_time ? new Date(v.create_time * 1000).toISOString().slice(0, 10) : '',
      views: viewsOf(v),
      likes: v.like_count || 0,
      comments: v.comment_count || 0,
      shares: v.share_count || 0,
      duration: v.duration || 0,
      url: v.share_url || null,
      breakout: viewsOf(v) >= thr,
    }));

  res.json({
    syncedAt: req.user.syncedAt || null,
    profile: req.user.profile,
    totals: { videos: vids.length, views: totalViews, likes: sum('like_count'), comments: sum('comment_count'), shares: sum('share_count') },
    avgViews: vids.length ? Math.round(totalViews / vids.length) : 0,
    medianViews: Math.round(median(vids.map(viewsOf))),
    engagementRate: totalViews ? interactions / totalViews : 0,
    breakout: { threshold: Math.round(thr), count: broke, rate: vids.length ? broke / vids.length : 0 },
    byWeekday,
    bestHours,
    videos,
  });
});

// Breakout prediction for a new video link
app.post('/api/predict', auth, async (req, res) => {
  const url = String(req.body.url || '').trim();
  let title = String(req.body.title || '');
  if (!title && /tiktok\.com/i.test(url)) {
    try {
      const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
      if (r.ok) title = (await r.json()).title || '';
    } catch { /* oEmbed unavailable - user can type hashtags manually */ }
  }
  const manual = req.body.hashtags !== undefined && req.body.hashtags !== '';
  const tags = manual ? Number(req.body.hashtags) || 0 : hashtagCount(title);

  const vids = req.user.videos;
  if (vids.length < 5) {
    return res.status(400).json({ error: 'Sync at least 5 of your videos first (needed for a reliable estimate).' });
  }
  const thr = breakoutLine(vids);
  let group = vids.filter((v) => Math.abs(hashtagCount(v.title) - tags) <= 1);
  let basis = 'your videos with a similar hashtag count';
  if (group.length < 5) { group = vids; basis = 'all your videos'; }

  const hits = group.filter((v) => viewsOf(v) >= thr).length;
  const urlId = (url.match(/\/video\/(\d+)/) || [])[1];
  const own = urlId ? vids.find((v) => v.id === urlId) || null : null;

  res.json({
    title,
    hashtags: tags,
    chance: Math.round((hits / group.length) * 100),
    expectedViews: Math.round(median(group.map(viewsOf))),
    breakoutThreshold: Math.round(thr),
    sample: group.length,
    basis,
    own: own ? { views: viewsOf(own), likes: own.like_count || 0, title: own.title } : null,
  });
});

// --- Exchange rates (USD base, USDT and TRX in USD) ---
let rateCache = { at: 0, data: null };
app.get('/api/rates', async (req, res) => {
  if (rateCache.data && Date.now() - rateCache.at < 10 * 60_000) return res.json(rateCache.data);
  try {
    const [fx, cg] = await Promise.all([
      fetch('https://open.er-api.com/v6/latest/USD').then((r) => r.json()),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether,tron&vs_currencies=usd').then((r) => r.json()),
    ]);
    rateCache = {
      at: Date.now(),
      data: { USD: 1, GBP: fx.rates.GBP, PLN: fx.rates.PLN, USDT_USD: cg.tether.usd, TRX_USD: cg.tron.usd, tax: TAX },
    };
    res.json(rateCache.data);
  } catch {
    if (rateCache.data) return res.json(rateCache.data);
    res.status(502).json({ error: 'Exchange rates unavailable' });
  }
});

// --- Income manager (amounts stored in USDT) ---
const iso = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

app.get('/api/income', auth, (req, res) => {
  res.json({ entries: req.user.income });
});

app.post('/api/income', auth, (req, res) => {
  const amount = Number(req.body.usdt);
  const date = req.body.date || iso(new Date());
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Enter a USDT amount and a date' });
  }
  const entry = { id: crypto.randomUUID(), date, usdt: round2(amount), note: String(req.body.note || '').slice(0, 120) };
  req.user.income.push(entry);
  save();
  res.json(entry);
});

app.delete('/api/income/:id', auth, (req, res) => {
  req.user.income = req.user.income.filter((e) => e.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.get('/api/income/chart', auth, (req, res) => {
  const range = req.query.range || 'month';
  const entries = req.user.income;
  const now = new Date();

  if (range === 'week' || range === 'month') {
    const days = range === 'week' ? 7 : 30;
    const keys = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      keys.push(iso(d));
    }
    const sums = Object.fromEntries(keys.map((k) => [k, 0]));
    entries.forEach((e) => { if (e.date in sums) sums[e.date] += e.usdt; });
    return res.json({ labels: keys, values: keys.map((k) => round2(sums[k])) });
  }

  // year = last 12 months, lifetime = from first entry to now
  let start;
  if (range === 'year') {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  } else {
    const first = entries.map((e) => e.date).sort()[0] || iso(now);
    const f = new Date(`${first}T00:00:00Z`);
    start = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1));
  }
  const months = [];
  for (let d = start; d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push(d.toISOString().slice(0, 7));
  }
  const sums = Object.fromEntries(months.map((m) => [m, 0]));
  entries.forEach((e) => { const m = e.date.slice(0, 7); if (m in sums) sums[m] += e.usdt; });
  res.json({ labels: months, values: months.map((m) => round2(sums[m])) });
});

app.listen(PORT, () => console.log(`CSMAFIA Hub running on ${BASE}`));
