# Fitness Agent — AI Training Assistant (Strava + Garmin + Telegram)

An AI fitness assistant that syncs activities from Strava and wellness data (HRV, sleep, body battery, stress) from a Garmin Forerunner 265, stores everything in Supabase, and answers natural-language questions about my training through Telegram — with Claude as the reasoning layer.

Commercial platforms keep activity data and recovery data in separate silos. This agent reasons across both: ask "how was my ride today" and it cross-references the ride against last night's sleep, HRV, and recent training load.

![Demo](<img width="509" height="664" alt="Screenshot 2026-06-12 091543" src="https://github.com/user-attachments/assets/f36c4f03-88c6-4066-adb3-951b4a4dab70" />)


## Architecture

```
Strava API ──┐
             ├──► Sync layer (Node.js) ──► Supabase ──► Claude (reasoning) ──► Telegram bot
Garmin ──────┘
```

## Features

- `/sync` — pulls recent activities from Strava and daily wellness metrics from Garmin
- `/stats` — 7-day training summary grouped by sport (distance, duration, avg HR)
- `/ask <question>` — free-form questions answered by Claude with full access to the synced data, e.g. comparing today's ride against past efforts and current recovery state

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js |
| Activity data | Strava API (OAuth) |
| Wellness data | `garminconnect` (unofficial — official API requires partner approval) |
| Database | Supabase (Postgres) |
| AI layer | Claude API via Composio tool integration |
| Interface | Telegram Bot API |
| Hosting | Render |

## The Hard Part

Garmin's official wellness API isn't available to individual developers, so wellness data comes through the unofficial `garminconnect` package. Session handling and token behavior are undocumented; auth failures silently broke the sync pipeline until I built proper session management and error handling around it. Strava's OAuth token refresh also needed an env-var fallback to survive redeploys on Render.

## Setup

1. Clone the repo and run `npm install`
2. Copy `.env.example` to `.env` and fill in your credentials:

```
TELEGRAM_BOT_TOKEN=your_token_here
STRAVA_CLIENT_ID=your_id_here
STRAVA_CLIENT_SECRET=your_secret_here
STRAVA_REFRESH_TOKEN=your_token_here
GARMIN_EMAIL=your_email_here
GARMIN_PASSWORD=your_password_here
SUPABASE_URL=your_url_here
SUPABASE_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

3. Run `node setup-db.js` to create the Supabase tables
4. Run `node connect-strava.js` to complete the Strava OAuth flow
5. Start the bot: `node bot.js`

**Never commit your `.env` file.** It's in `.gitignore` for a reason.

## What I Learned

Working with undocumented APIs, OAuth token lifecycle management, database schema design for time-series fitness data, LLM tool use, and building a conversational interface around real personal data.
