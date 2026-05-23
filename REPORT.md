# Fitness Bot — Technical Report

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Purpose & Use Case](#2-purpose--use-case)
3. [Architecture Overview](#3-architecture-overview)
4. [Tech Stack](#4-tech-stack)
5. [Data Sources](#5-data-sources)
6. [Database Schema](#6-database-schema)
7. [Bot Commands](#7-bot-commands)
8. [AI Integration](#8-ai-integration)
9. [Automation](#9-automation)
10. [Deployment](#10-deployment)
11. [Security Considerations](#11-security-considerations)
12. [Limitations & Known Constraints](#12-limitations--known-constraints)
13. [Future Improvements](#13-future-improvements)
14. [Summary](#summary)

---

## 1. Project Overview

Fitness Bot is a personal health and training assistant delivered through Telegram. It connects two fitness data sources — Strava (activity tracking) and Garmin Connect (wellness and biometric monitoring) — pulls their data into a persistent Supabase database, and exposes that data through a set of Telegram commands. Two of those commands invoke a Llama 3.3 language model via the Groq API to generate natural-language coaching responses grounded in real user data.

The bot is written in Node.js (CommonJS), deployed on Render's free tier as a persistent web service, and runs 24/7 without any intervention from the user. All credentials are stored as environment variables and never committed to version control.

The target user is an individual athlete or fitness enthusiast who already uses Garmin devices and Strava, wants a unified view of their training and recovery data, and wants AI-powered coaching responses without needing to manually export data or switch between apps.

---

## 2. Purpose & Use Case

Both Garmin Connect and Strava are excellent at collecting fitness data. Garmin Connect specialises in biometric wellness data — sleep quality, heart rate variability, body battery, stress scores, SpO2 — while Strava focuses on activity logging, route tracking, and performance metrics across runs, rides, swims, and strength sessions.

Neither platform offers a conversational interface for asking questions about your own data. Garmin Connect has a summary dashboard and Strava has segment leaderboards, but neither answers questions like "should I train hard today?" or "how has my sleep affected my run performance this week?" Those questions require correlating data across both platforms simultaneously, which neither app does natively.

Fitness Bot solves this by:

- Pulling activity data from Strava and wellness data from Garmin into a single relational database
- Exposing clean, readable summaries via Telegram commands that are available anywhere a user has their phone
- Passing structured data to a large language model that can reason over it and produce specific, data-referenced coaching responses

Telegram specifically was chosen as the interface because it requires no app installation beyond what most users already have, works on any device, supports persistent chat history, and is accessible globally without latency concerns.

---

## 3. Architecture Overview

### High-Level Flow

```
Strava API ──────────────────────────────────────────┐
                                                      │
                                                      ▼
Garmin Connect API ───────────────────────► syncStrava() / syncGarminForDate()
                                                      │
                                                      ▼
                                              Supabase (PostgreSQL)
                                          ┌───────────────────────┐
                                          │  activities table     │
                                          │  wellness table       │
                                          └───────────────────────┘
                                                      │
                                                      ▼
Telegram User ──► bot.onText() ──► Query Supabase ──► Format response
                                          │
                                          ▼ (for /recovery and /ask only)
                                    Groq API (Llama 3.3 70B)
                                          │
                                          ▼
                                  Natural language response
                                          │
                                          ▼
                              bot.sendMessage() ──► Telegram User
```

### Component Roles

**Telegram** acts as the interface layer. The bot runs in polling mode, meaning it continuously asks Telegram's servers whether any new messages have arrived. When a user sends a command, the relevant handler fires, queries the database, optionally calls the LLM, and sends a response back through Telegram's API.

**Supabase** acts as the data layer. It is a hosted PostgreSQL database with a REST API (PostgREST). The bot uses the `@supabase/supabase-js` client to perform upserts (insert-or-update operations) during sync and SELECT queries during command handling. The database stores all historical activity and wellness data persistently.

**Strava** is a data source for activities. The bot authenticates using OAuth2 with the user's own Strava API application credentials, stores tokens locally (or in environment variables on Render), and fetches the 10 most recent activities via the Strava REST API on each sync.

**Garmin Connect** is a data source for wellness and biometric data. Authentication is performed through a multi-step OAuth flow: SSO login → OAuth1 token exchange → OAuth2 token exchange, using consumer keys fetched from a public S3 URL maintained by the open-source `garth` project. The resulting OAuth2 Bearer token is cached and used for all subsequent API calls.

**Groq / Llama 3.3** acts as the intelligence layer. Two commands (`/recovery` and `/ask`) pass structured fitness data to the Llama 3.3 70B model hosted on Groq's inference platform. The model generates concise coaching responses referencing actual numbers from the user's data.

---

## 4. Tech Stack

### Runtime & Language
- **Node.js v24** — JavaScript runtime. CommonJS module format (`require`/`module.exports`) is used throughout, as specified at project creation via `"type": "commonjs"` in `package.json`.

### Core Dependencies

| Package | Version | Role |
|---|---|---|
| `node-telegram-bot-api` | ^0.67.0 | Telegram Bot API client. Handles polling, message parsing, and sending replies. |
| `@supabase/supabase-js` | ^2.106.1 | Official Supabase client. Used for all database reads and writes. |
| `groq-sdk` | ^1.2.0 | Official Groq SDK. Used to call the Llama 3.3 70B model for `/recovery` and `/ask`. |
| `axios` | (transitive) | HTTP client used by the Garmin OAuth flow for SSO login and API calls. Available via `garmin-connect`'s dependency tree. |
| `qs` | (transitive) | Query string serialisation/parsing. Used in Garmin OAuth URL encoding and response parsing. Available via `axios`. |
| `oauth-1.0a` | (transitive) | OAuth 1.0a signing. Used in the Garmin OAuth1 token exchange step. Available via `garmin-connect`. |
| `node-cron` | ^4.2.1 | Cron-style job scheduler. Runs the automatic daily sync at 6 AM. |
| `dotenv` | ^17.4.2 | Loads environment variables from `.env` file into `process.env` at startup. |

### Dependencies Present But No Longer Active

| Package | Status | Reason |
|---|---|---|
| `garmin-connect` | Installed, not used directly | The package's built-in login flow was found to be broken (Garmin's OAuth consumer key endpoint rejects its credentials). A custom OAuth implementation was built instead. The package remains because `axios`, `qs`, and `oauth-1.0a` are sourced from its dependency tree. |
| `@anthropic-ai/sdk` | Installed, not used | Originally used to call Claude via the Anthropic API. Replaced by `groq-sdk` to avoid API credit costs. The free Groq tier with Llama 3.3 covers all use cases for this bot. |
| `composio-core` | Installed, not used | Originally intended to manage Strava OAuth. Abandoned after discovering that Composio's API redacts all token values in responses, making it impossible to retrieve usable credentials. Strava OAuth is now managed directly. |

### Built-in Node.js Modules Used
- `https` — Direct HTTPS requests to the Strava REST API and Strava OAuth token endpoint
- `http` — HTTP server for Render's health check endpoint
- `fs` — File system access for reading and writing cached token files
- `path` — Cross-platform file path construction
- `crypto` — HMAC-SHA1 hashing for OAuth1 request signing

---

## 5. Data Sources

### Strava

**Authentication:** OAuth2. The user created a Strava API application at `strava.com/settings/api`, which issued a `client_id` and `client_secret`. A one-time authorisation flow (via `strava-setup.js` and `strava-exchange.js`) produced an initial access token and refresh token, which are stored as environment variables (`STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN`, `STRAVA_TOKEN_EXPIRES_AT`). Strava access tokens expire every 6 hours. The bot automatically refreshes them using the refresh token before they expire.

**Data fetched:** The 10 most recent activities via `GET /api/v3/athlete/activities?per_page=10`. Each activity provides:
- Activity ID, name, sport type
- Start date and time
- Distance (metres), moving time (seconds)
- Calories burned
- Average and maximum heart rate (when available from a paired sensor)
- The full raw JSON response is also stored for future use

**Activity types covered:** Any activity type Strava supports — runs, rides, virtual rides, swims, weight training sessions, hikes, walks, etc. The `sport_type` field from Strava maps directly to the `type` column in Supabase.

### Garmin Connect

**Authentication:** A four-step OAuth flow implemented from scratch, because no working official or third-party library was available at the time of development:

1. **SSO Login** — POST to `sso.garmin.com/sso/signin` with email, password, and a CSRF token extracted from the sign-in page. Returns a CAS service ticket.
2. **OAuth1 Token Exchange** — GET to `connectapi.garmin.com/oauth-service/oauth/preauthorized` with the ticket, signed using OAuth1 HMAC-SHA1 with consumer keys fetched from `thegarth.s3.amazonaws.com/oauth_consumer.json` (a public key set maintained by the open-source `garth` project). Returns an OAuth1 token pair.
3. **OAuth2 Token Exchange** — POST to `connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0` signed with the OAuth1 token. Returns a JWT access token valid for approximately 22–29 hours.
4. **Token Caching** — The OAuth2 token is written to `.garmin-tokens.json` and reused until it expires, avoiding a full re-login on every sync.

**Data fetched per sync:** Seven parallel or sequential API calls to `connectapi.garmin.com`:

| Endpoint | Data |
|---|---|
| `/sleep-service/sleep/dailySleepData?date=` | Sleep score, deep/light/REM/awake seconds |
| `/wellness-service/wellness/dailyHeartRate?date=` | Resting heart rate |
| `/usersummary-service/stats/steps/daily/{date}/{date}` | Step count |
| `/hrv-service/hrv/{date}` | HRV weekly average |
| `/usersummary-service/usersummary/daily/{displayName}?calendarDate=` | Body battery high/low, average stress, intensity minutes |
| `/wellness-service/wellness/dailyOximetry/{displayName}?calendarDate=` | Average SpO2 |
| `/wellness-service/wellness/dailyRespiration/{displayName}?calendarDate=` | Average respiration rate |

**Why Garmin over Strava for wellness:** Strava only records activities. Garmin's wearables (e.g., Forerunner 265) monitor the user continuously — during sleep, rest, and all waking hours — capturing data that Strava never sees. HRV, body battery, stress scores, SpO2, and sleep stage breakdowns are exclusively available from Garmin.

**Why email/password instead of an official API:** Garmin does not offer a public OAuth API for consumer wellness data. The `garmin-connect` npm package and the Python `garth` library both reverse-engineer Garmin Connect's internal API by replicating the authentication flow used by Garmin's own mobile apps. This is an unofficial approach and carries inherent fragility risk (see Section 12).

---

## 6. Database Schema

The database is hosted on Supabase (PostgreSQL). Two tables exist: `activities` and `wellness`. They are separated because the data is fundamentally different in nature — activities are discrete events with a start time and duration, while wellness entries are daily aggregates tied to a calendar date.

### `activities` Table

| Column | Type | Description |
|---|---|---|
| `id` | `BIGSERIAL PRIMARY KEY` | Auto-incrementing internal row ID |
| `activity_id` | `TEXT UNIQUE NOT NULL` | Strava's activity ID (string). The unique constraint enables upserts — syncing the same activity twice does not create duplicates. |
| `name` | `TEXT` | Activity name as set by the user in Strava (e.g. "Morning Run") |
| `type` | `TEXT` | Sport type (e.g. "Run", "Ride", "WeightTraining") |
| `date` | `TEXT` | ISO 8601 start datetime from Strava (e.g. `2026-05-22T07:30:00Z`) |
| `distance` | `FLOAT` | Distance in metres. Null for activities with no GPS (e.g. weight training) |
| `duration` | `INTEGER` | Moving time in seconds |
| `calories` | `FLOAT` | Estimated calories burned. Often null unless a power meter or HR monitor is used. |
| `average_hr` | `FLOAT` | Average heart rate in bpm. Null if no HR sensor was paired. |
| `max_hr` | `FLOAT` | Maximum heart rate in bpm |
| `source` | `TEXT` | Always `'strava'`. Reserved for future multi-source support. |
| `raw` | `TEXT` | Full JSON payload from Strava, stringified. Preserves all fields not explicitly mapped. |
| `created_at` | `TIMESTAMPTZ DEFAULT NOW()` | Row creation timestamp |

**Upsert logic:** `onConflict: 'activity_id'` — if a row with the same `activity_id` already exists, it is updated in place. This makes `/sync` idempotent.

### `wellness` Table

| Column | Type | Description |
|---|---|---|
| `id` | `BIGSERIAL PRIMARY KEY` | Auto-incrementing internal row ID |
| `date` | `TEXT UNIQUE NOT NULL` | Calendar date in `YYYY-MM-DD` format. The unique constraint enables upserts by date. |
| `sleep_score` | `INTEGER` | Garmin's composite sleep quality score (0–100) |
| `sleep_deep_seconds` | `INTEGER` | Seconds spent in deep (slow-wave) sleep |
| `sleep_light_seconds` | `INTEGER` | Seconds spent in light sleep |
| `sleep_rem_seconds` | `INTEGER` | Seconds spent in REM sleep |
| `sleep_awake_seconds` | `INTEGER` | Seconds spent awake during the sleep window |
| `hrv_weekly_avg` | `FLOAT` | HRV 7-day rolling average in milliseconds. More stable than nightly HRV. |
| `body_battery_high` | `INTEGER` | Peak body battery level for the day (0–100) |
| `body_battery_low` | `INTEGER` | Lowest body battery level for the day |
| `resting_hr` | `INTEGER` | Resting heart rate in bpm, measured during the lowest-activity period |
| `avg_stress` | `INTEGER` | Average stress level (0–100) derived from HRV fluctuations throughout the day |
| `spo2_avg` | `FLOAT` | Average blood oxygen saturation percentage |
| `steps` | `INTEGER` | Total step count for the day |
| `intensity_minutes` | `INTEGER` | Sum of moderate and vigorous intensity minutes |
| `respiration_avg` | `FLOAT` | Average breaths per minute |
| `raw` | `TEXT` | Stringified JSON containing the full responses from sleep, HR, HRV, and daily summary endpoints |
| `created_at` | `TIMESTAMPTZ DEFAULT NOW()` | Row creation timestamp |

**Upsert logic:** `onConflict: 'date'` — syncing the same date twice overwrites the existing row with fresh data. This means re-running `/sync` always reflects the latest data from Garmin (useful since Garmin continues processing sleep data for several hours after waking).

---

## 7. Bot Commands

### `/sync`

**What it does:**
1. Calls `syncStrava()`: fetches the 10 most recent Strava activities via the Strava REST API and upserts each one into the `activities` table
2. Calls `syncGarminForDate()` for today's date and yesterday's date: performs the full Garmin data fetch across 7 endpoints per date and upserts each into the `wellness` table
3. Reports how many activities were synced and which dates were saved

**LLM:** No

**User sees:** A summary message like `Synced 10 activities. Wellness data saved for: 2026-05-23, 2026-05-22.` Error messages appear inline if any individual source fails.

---

### `/sleep`

**What it does:**
1. Queries the `wellness` table for the single most recent row ordered by `date DESC`
2. Calculates total sleep duration by summing the four stage columns
3. Formats a structured text report

**LLM:** No

**User sees:**
```
Sleep Report — 2026-05-23
Score: 94
Total: 8h 38m
Deep: 2h 21m
Light: 3h 31m
REM: 2h 32m
Awake: 0h 14m
HRV Weekly Avg: 71 ms
Body Battery: 100 high / 20 low
```

---

### `/stats`

**What it does:**
1. Queries the `activities` table for all rows where `date >= 7 days ago`
2. Groups activities by `type`
3. For each type, aggregates total count, total distance (converted to km), total duration (converted to minutes), and average heart rate

**LLM:** No

**User sees:** A grouped summary like:
```
Activity Summary — Last 7 Days
Total workouts: 10

Run: 2 session(s)
  Distance: 16.0 km  Duration: 87 min  Avg HR: 151

WeightTraining: 5 session(s)
  Distance: 0.0 km  Duration: 187 min  Avg HR: 115
```

---

### `/recovery`

**What it does:**
1. Queries the `wellness` table for the most recent row
2. Extracts the five key recovery metrics: body battery, HRV weekly average, average stress, resting HR, SpO2
3. Formats those metrics as a structured string
4. Sends that string to Llama 3.3 70B via Groq with a prompt requesting a 2–3 sentence readiness summary and training recommendation
5. Appends the model's response to the raw metrics

**LLM:** Yes — `llama-3.3-70b-versatile`, max 300 tokens

**User sees:** The raw metrics block followed immediately by the model's coaching paragraph.

---

### `/ask [question]`

**What it does:**
1. Accepts any freeform question as the command argument
2. Queries the `activities` table for the last 7 days (selecting specific columns only, excluding `raw`)
3. Queries the `wellness` table for the last 7 days (selecting specific columns only, excluding `raw`)
4. Formats both datasets into compact single-line-per-row text to minimise token usage
5. Sends the question plus the formatted data context to Llama 3.3 70B
6. Returns the model's response

**LLM:** Yes — `llama-3.3-70b-versatile`, max 800 tokens

**User sees:** A direct answer to their question referencing specific data points. Example: `/ask should I do a 2-hour bike workout today?` returns a response citing body battery, HRV, recent training volume, and stress levels.

**Token limit note:** The context is deliberately formatted in compact single-line form (not full JSON) to stay within Groq's free tier limit of 12,000 tokens per minute.

---

### `/history [days]`

**What it does:**
1. Accepts an optional integer argument (defaults to 7, capped at 30)
2. Iterates from 1 day ago back to N days ago
3. Calls `syncGarminForDate()` for each date sequentially
4. Reports progress per date as it goes

**LLM:** No

**User sees:** One confirmation message per successfully saved date, then a final completion summary. Failed dates are reported individually without stopping the loop.

---

## 8. AI Integration

### Model

**Groq API** hosts Meta's **Llama 3.3 70B Versatile** model (`llama-3.3-70b-versatile`). Groq's inference platform runs on custom LPU (Language Processing Unit) hardware, making it exceptionally fast — responses typically arrive in under 2 seconds. The free tier allows 30 requests per minute and 14,400 requests per day, which is more than sufficient for personal use.

### System Prompt

```
You are a personal fitness coach assistant. You have access to the user's real 
training and recovery data from Garmin and Strava. Be concise, specific, and 
practical. Always reference actual numbers from the data in your response.
```

This prompt is intentionally short and directive. The three key constraints — concise, specific, practical — prevent the model from producing generic fitness advice that ignores the actual data. The instruction to "always reference actual numbers" ensures the response is grounded in the user's real metrics rather than general knowledge.

### Commands That Call the LLM

| Command | Token Budget | What the model receives |
|---|---|---|
| `/recovery` | max 300 tokens output | The 5 recovery metrics for the most recent date as a formatted string |
| `/ask` | max 800 tokens output | The user's question + 7 days of activities and wellness data in compact text format |

### Data Passed to the Model

For `/recovery`, the model receives only the metrics for the most recent day:
```
Recovery Metrics — 2026-05-23
Body Battery: 100 high / 20 low
HRV Weekly Avg: 71 ms
Avg Stress: 12
Resting HR: 44 bpm
SpO2: N/A%
```

For `/ask`, the model receives a compact representation of 7 days of both activity and wellness data:
```
Recent Activities (last 7 days):
2026-05-21 WeightTraining "Afternoon Weight Training" dist:N/A dur:45min avgHR:115
2026-05-20 Run "Morning Run" dist:8.2km dur:43min avgHR:152
...

Wellness (last 7 days):
2026-05-23 sleep:94 deepSleep:141min HRV:71 battery:100high/20low HR:44 stress:12 steps:526
2026-05-22 sleep:64 deepSleep:97min HRV:72 battery:N/Ahigh/N/Alow HR:46 stress:18 steps:8423
...
```

The `raw` columns from both tables are explicitly excluded from `/ask` queries. These columns contain the full Garmin and Strava API payloads, which can be thousands of tokens each and would immediately exceed the free tier rate limit.

---

## 9. Automation

### Cron Job

A `node-cron` job is scheduled to run at **6:00 AM server time** every day:

```javascript
cron.schedule('0 6 * * *', async () => {
  await syncStrava();
  await syncGarminForDate(today);
  await syncGarminForDate(yesterday);
});
```

This job performs the same sync that `/sync` does manually — pulling the latest Strava activities and Garmin wellness data for both today and yesterday.

### Render Free Tier Limitation

**The cron job is unreliable on Render's free tier.** Render's free tier web services spin down after 15 minutes of inactivity (no incoming HTTP requests). When the service is spun down, Node.js is not running, so `node-cron` cannot fire.

The service spins back up when an incoming request arrives (such as a Telegram polling response), but the cold start takes 30–60 seconds, during which messages may be delayed or dropped.

**Practical consequence:** The 6 AM auto-sync will only fire if the bot happens to still be active at that time (e.g., if the user was interacting with it recently). On most mornings, it will not fire automatically.

**Workaround options:**
1. **Manual sync** — Send `/sync` each morning after waking up. Since the bot wakes on the first message, the sync will succeed after the cold start.
2. **Render paid tier** — Upgrading to Render's Starter tier ($7/month) keeps the service always-on, making the cron job fully reliable.
3. **External ping service** — A service like UptimeRobot can ping the bot's health check URL every 5 minutes, preventing it from ever spinning down. This effectively makes the free tier always-on.

---

## 10. Deployment

### Render

The bot is deployed as a **Web Service** on Render's free tier. Render builds and runs the service directly from the GitHub repository. On each push to the `main` branch, Render automatically pulls the latest code, runs `npm install`, and restarts the service with `node bot.js`.

**Build command:** `npm install`
**Start command:** `node bot.js`
**Instance type:** Free (512 MB RAM, shared CPU)

### GitHub Integration

The repository is hosted at `github.com/alexdortiz/fitness-bot`. Render is connected to this repository via GitHub OAuth. Any `git push` to the `main` branch automatically triggers a new Render deployment within 1–2 minutes. No manual deploy steps are required after the initial setup.

### Health Check HTTP Server

Render requires web services to bind to a port and respond to HTTP requests. Without this, Render considers the service crashed and will restart it repeatedly.

The bot starts a minimal HTTP server on `process.env.PORT || 3000`:

```javascript
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('Bot is running.');
  }
});
server.listen(process.env.PORT || 3000);
```

This server serves no functional purpose for the bot — it exists solely to satisfy Render's health check requirement. Render injects the `PORT` environment variable automatically.

### Environment Variables

All secrets are stored as environment variables. Locally, they live in a `.env` file which is loaded at startup by `dotenv`. On Render, they are set via the Render dashboard's Environment section and injected into the process at runtime.

| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | Bot API token from BotFather |
| `GROQ_API_KEY` | API key from console.groq.com |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service role key |
| `GARMIN_EMAIL` | Garmin account email |
| `GARMIN_PASSWORD` | Garmin account password |
| `STRAVA_CLIENT_ID` | Strava API app client ID |
| `STRAVA_CLIENT_SECRET` | Strava API app client secret |
| `STRAVA_ACCESS_TOKEN` | Current Strava OAuth2 access token |
| `STRAVA_REFRESH_TOKEN` | Strava OAuth2 refresh token (long-lived) |
| `STRAVA_TOKEN_EXPIRES_AT` | Unix timestamp of access token expiry |

The `.env` file and all token cache files (`.strava-tokens.json`, `.garmin-tokens.json`) are listed in `.gitignore` and are never committed to GitHub.

---

## 11. Security Considerations

### .env Is Gitignored

The `.env` file contains every credential the bot uses. It is explicitly listed in `.gitignore` and has never been committed to the repository. The GitHub repository contains no secrets. This is the single most important security practice in the project.

### Garmin Email/Password Authentication

The Garmin integration requires the user's actual Garmin account email and password, stored as plaintext environment variables. This is an inherent tradeoff of using an unofficial API — Garmin does not offer a public OAuth2 flow for consumer wellness data access.

**Risk assessment:**
- If the Render service is compromised, an attacker could read `GARMIN_EMAIL` and `GARMIN_PASSWORD` from the environment
- The Garmin account is not directly linked to financial data, but it contains health history and personal biometrics
- The password is used only to obtain an OAuth2 token, which is cached — the password itself is not transmitted on every request

**Mitigation:** Use a strong, unique password for the Garmin account that is not shared with any other service.

### Strava OAuth2

Strava uses proper OAuth2. The user's Strava password is never stored anywhere in the system. The stored credentials are an access token (short-lived, 6-hour expiry) and a refresh token (long-lived, reusable). If the access token is compromised, an attacker can read activity data but cannot log into the Strava account or modify data. Revoking the application's access in Strava's settings immediately invalidates all tokens.

### What To Do If Credentials Are Exposed

If any credential is accidentally committed to GitHub or otherwise exposed:
1. Rotate it immediately at the relevant provider
2. Revoke the old credential
3. Update the environment variable on Render
4. If `.env` was committed, remove it from git history using `git filter-branch` or the BFG Repo Cleaner

### Additional Best Practices

- Do not share the Render service URL publicly — the health check endpoint confirms the bot is running
- Periodically rotate the `GROQ_API_KEY` and `SUPABASE_KEY`
- Review Strava's connected applications page periodically at `strava.com/settings/apps`

---

## 12. Limitations & Known Constraints

### Render Free Tier Sleep Behaviour

Render's free tier spins down web services after 15 minutes of inactivity. When spun down, the first incoming message (from Telegram's polling) triggers a cold start that takes 30–60 seconds. During this window, the bot is unresponsive. The cron job cannot fire while the service is sleeping.

### Unofficial Garmin API Fragility

The Garmin authentication flow is reverse-engineered from Garmin's mobile apps. Garmin has changed this flow at least once historically (migrating from `/modern/` to `/app/` URL paths for Connect), and the SSO login implementation was rebuilt twice during development. There is no guarantee Garmin will not change the flow again. Any significant change to Garmin's authentication infrastructure could break the Garmin sync without warning.

The OAuth consumer keys fetched from `thegarth.s3.amazonaws.com/oauth_consumer.json` are maintained by a third party (the open-source `garth` project). If that S3 object is removed or the keys are revoked by Garmin, the entire Garmin auth flow will fail.

### Strava Token Expiry on Render

Strava access tokens expire every 6 hours. The bot refreshes them automatically when they expire, writing the new token back to `.strava-tokens.json`. On Render, the file system is ephemeral — it is reset on every deploy. The refreshed token is therefore lost on redeployment.

The current workaround stores the initial tokens as environment variables. However, refreshed tokens are only written to the local file and not back to Render's environment variables. After a deploy, the bot will use the (potentially expired) token from the environment variable and attempt a refresh. This works correctly as long as the refresh token (which has a much longer lifetime) is still valid. The refresh token is stable and does not need to be updated after normal token refreshes.

### Groq Free Tier Rate Limits

The Groq free tier limits requests to 30 per minute and 14,400 per day for `llama-3.3-70b-versatile`. For a single-user bot, this is effectively unlimited for normal use. The `/ask` command was specifically engineered to use compact text formatting rather than full JSON to stay within the 12,000 token-per-minute limit.

### History Backfill Cap

The `/history` command is capped at 30 days. This was a deliberate conservative choice. The cap can be raised by modifying a single line in bot.js (`Math.min(parseInt(match[1]) || 7, 30)`). Garmin stores historical wellness data going back years.

---

## 13. Future Improvements

### Infrastructure

- **Upgrade to Render Starter tier ($7/month)** — Eliminates cold starts entirely, makes the 6 AM cron job reliable, and ensures the bot responds instantly to every message.
- **External uptime monitoring** — Services like UptimeRobot can ping the health check endpoint every 5 minutes for free, preventing the free tier from ever sleeping. This is a no-cost alternative to upgrading Render.
- **Persistent token storage** — Store refreshed Strava tokens back to Supabase rather than the local file system, so they survive Render redeployments without manual environment variable updates.

### New Commands

- **`/week`** — A weekly training summary combining total volume, load, average sleep score, and HRV trend. Currently `/stats` covers activities but not a full week-over-week comparison.
- **`/today`** — A morning briefing combining yesterday's sleep, current body battery, and today's planned workout suggestion based on recent load.
- **`/trend [metric] [days]`** — Show a multi-day trend for a specific metric (e.g., `/trend hrv 14` for 14-day HRV trend).
- **`/pr`** — Personal records for key metrics (longest run, highest weekly volume, best sleep score, etc.)

### AI Enhancements

- **Conversation memory** — Store the last N exchanges per user in Supabase and include them in the LLM context, enabling multi-turn conversations like "now plan my week based on that."
- **Proactive insights** — Push a morning message automatically when the cron job fires, including a brief AI summary of overnight recovery without the user needing to ask.
- **Training load analysis** — Calculate Acute:Chronic Workload Ratio (ACWR) from the activities table and include it in `/recovery` context for more sophisticated training load recommendations.

### Data & Integrations

- **Extended history** — Raise the `/history` cap to 365 days and add a one-time bulk import command.
- **Official Garmin API** — Garmin has a Health API for certified developers. If the unofficial API breaks, migrating to the official API would provide stable, supported data access, though it requires a formal application process.
- **Nutrition integration** — Connecting a nutrition tracker (MyFitnessPal, Cronometer) would allow the AI to correlate food intake with sleep quality and training performance.
- **Web dashboard** — A simple read-only web interface served from the same Render deployment, visualising trends with charts. Libraries like Chart.js could render historical data as SVGs served over the existing HTTP server.

---

## Summary

Fitness Bot is a self-hosted, end-to-end personal coaching system that bridges two leading fitness platforms — Strava and Garmin Connect — with a conversational AI interface delivered through Telegram. It solves the practical problem of having rich fitness and biometric data scattered across multiple apps with no unified intelligence layer. The system is architecturally straightforward: data is pulled from external APIs on demand, persisted in a hosted PostgreSQL database, and surfaced through six Telegram commands, two of which invoke a Llama 3.3 language model to generate contextualised coaching responses. The bot runs 24/7 on Render with no ongoing maintenance required, updates automatically from GitHub on every code push, and handles all token refresh and re-authentication transparently. The primary technical challenges encountered and solved during development were Garmin's unofficial OAuth flow (requiring a custom four-step implementation), Strava token management on an ephemeral file system, and Groq token rate limits requiring compact data serialisation. The result is a fully functional, production-deployed bot that answers questions about real training data in natural language from any device with Telegram installed.
