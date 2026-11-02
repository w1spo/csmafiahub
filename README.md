# CSMAFIA Creator Hub

TikTok analytics + breakout predictor + CSMAFIA payout calculator + income manager with UK tax tracker.

Stack: Node.js + Express (one server file), vanilla JS frontend, Chart.js from CDN. No database, no build step.

## Files

```
server.js        backend: TikTok OAuth, sync, stats, prediction, rates, income
public/index.html frontend markup
public/style.css  black/white gradient theme
public/app.js     frontend logic
package.json
```

## 1. Run locally

```bash
npm install
TIKTOK_CLIENT_KEY=xxx TIKTOK_CLIENT_SECRET=yyy SESSION_SECRET=any-long-random-string node server.js
```

Open http://localhost:3000. The calculator, rates and income manager work locally.
TikTok login requires HTTPS (see step 2), so for local testing use a tunnel such as ngrok and set `PUBLIC_URL` to the HTTPS address.

## 2. Create the TikTok app

1. Go to https://developers.tiktok.com, create an app and add the **Login Kit** product.
2. Request these scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`.
3. Add the redirect URI (must be HTTPS):
   `https://YOUR-SERVICE.onrender.com/auth/tiktok/callback`
4. Copy the **Client key** and **Client secret**.

Note: `video.list` needs TikTok app review before it works for accounts other than test users. Until then you can test with the developer account added in the sandbox.

## 3. Deploy on Render

1. Put the folder in a GitHub repo (or upload it), then in Render: **New → Web Service**.
2. Settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
3. Environment variables:

| Key | Value |
|---|---|
| `TIKTOK_CLIENT_KEY` | from TikTok developer portal |
| `TIKTOK_CLIENT_SECRET` | from TikTok developer portal |
| `PUBLIC_URL` | `https://YOUR-SERVICE.onrender.com` (no trailing slash) |
| `SESSION_SECRET` | a long random string |
| `DATA_FILE` | `/var/data/data.json` (only if you add a disk, see below) |

4. **Data storage:** the app saves to a JSON file. Render's free plan has an ephemeral disk, so data is lost on every redeploy/restart. For persistence, add a **Disk** (mount path `/var/data`, paid plan) and set `DATA_FILE`.

## 4. Using it

- **TikTok tab:** log in → paste your profile link → **Sync videos** → use the **Breakout predictor** with any video link.
- **CSMAFIA tab:** payout calculator ($0.75 per 1,000 views, 1,000 to 300,000 views) with USD/GBP/PLN, USDT and TRX output.
- **Income manager:** add income in USDT, view the chart by week/month/year/lifetime and track the UK tax thresholds for the current tax year (6 April to 5 April).
- The currency selector in the top bar changes all values. Rates refresh every 10 minutes.

## Important limits

- **Official TikTok API only gives access to the logged-in account.** Other people's profiles cannot be analysed through the API. The profile link must be your own.
- **Breakout chance** is a heuristic: the share of your past videos with a similar hashtag count that reached 2× your median views. It needs at least 5 synced videos.
- **UK tax** figures are estimates, not tax advice. Thresholds (£1,000 trading allowance, £12,570 personal allowance) are in `TAX` in `server.js`.
- Tokens are stored in the JSON file in plain text. Keep the disk private.
