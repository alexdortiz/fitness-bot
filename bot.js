require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const qs = require('qs');
const OAuth1 = require('oauth-1.0a');
const crypto = require('crypto');
const cron = require('node-cron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Initialize clients
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STRAVA_TOKEN_FILE = path.join(__dirname, '.strava-tokens.json');
const GARMIN_TOKEN_FILE = path.join(__dirname, '.garmin-tokens.json');
const GARMIN_BASE = 'https://connectapi.garmin.com';
const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const GARMIN_OAUTH_URL = `${GARMIN_BASE}/oauth-service/oauth`;
const UA_MOBILE = 'com.garmin.android.apps.connectmobile';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// --- GARMIN CLIENT (OAuth2) ---

class GarminClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.displayName = null;
    this.http = axios.create({ maxRedirects: 5, validateStatus: () => true });
  }

  async getToken() {
    if (this.accessToken && Date.now() / 1000 < this.tokenExpiry - 300) return this.accessToken;
    try {
      const saved = JSON.parse(fs.readFileSync(GARMIN_TOKEN_FILE, 'utf8'));
      if (saved.expires_at > Date.now() / 1000 + 300) {
        this.accessToken = saved.access_token;
        this.tokenExpiry = saved.expires_at;
        this.displayName = saved.displayName;
        return this.accessToken;
      }
    } catch {}
    await this._fullLogin();
    return this.accessToken;
  }

  async _fullLogin() {
    const consumerRes = await axios.get('https://thegarth.s3.amazonaws.com/oauth_consumer.json');
    const consumer = { key: consumerRes.data.consumer_key, secret: consumerRes.data.consumer_secret };

    const signinParams = qs.stringify({
      id: 'gauth-widget', embedWidget: 'true', locale: 'en',
      gauthHost: SSO_EMBED, service: SSO_EMBED, source: SSO_EMBED,
      redirectAfterAccountLoginUrl: SSO_EMBED, redirectAfterAccountCreationUrl: SSO_EMBED,
    });
    const signinUrl = `https://sso.garmin.com/sso/signin?${signinParams}`;
    const cookies = {};
    const setCookies = (h) => { for (const c of (h||[])) { const [kv]=c.split(';'); const eq=kv.indexOf('='); if(eq<0)continue; cookies[kv.slice(0,eq).trim()]=kv.slice(eq+1).trim(); }};
    const cookieHdr = () => Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ');

    const r1 = await this.http.get(signinUrl, { headers: { 'User-Agent': UA_BROWSER } });
    setCookies(r1.headers['set-cookie']);
    const csrfMatch = String(r1.data).match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) throw new Error('Garmin SSO: no CSRF token');

    const r2 = await this.http.post(signinUrl,
      qs.stringify({ username: process.env.GARMIN_EMAIL, password: process.env.GARMIN_PASSWORD, embed: 'true', _csrf: csrfMatch[1] }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHdr(), Origin: 'https://sso.garmin.com', Referer: signinUrl, 'User-Agent': UA_BROWSER } }
    );
    setCookies(r2.headers['set-cookie']);
    const ticketMatch = String(r2.data).match(/ticket=([^"&\s<]+)/);
    if (!ticketMatch) throw new Error('Garmin SSO: login failed — check credentials');

    const oauth = new OAuth1({ consumer, signature_method: 'HMAC-SHA1', hash_function: (b, k) => crypto.createHmac('sha1', k).update(b).digest('base64') });
    const preAuthUrl = `${GARMIN_OAUTH_URL}/preauthorized?` + qs.stringify({ ticket: ticketMatch[1], 'login-url': SSO_EMBED, 'accepts-mfa-tokens': true });
    const r3 = await this.http.get(preAuthUrl, { headers: { ...oauth.toHeader(oauth.authorize({ url: preAuthUrl, method: 'GET' })), 'User-Agent': UA_MOBILE } });
    if (r3.status !== 200) throw new Error(`Garmin OAuth1 failed (${r3.status})`);
    const oauth1Token = qs.parse(String(r3.data));

    const token = { key: oauth1Token.oauth_token, secret: oauth1Token.oauth_token_secret };
    const exchangeUrl = `${GARMIN_OAUTH_URL}/exchange/user/2.0`;
    const step4Params = oauth.authorize({ url: exchangeUrl, method: 'POST' }, token);
    const r4 = await this.http.post(`${exchangeUrl}?${qs.stringify(step4Params)}`, null, {
      headers: { 'User-Agent': UA_MOBILE, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (r4.status !== 200) throw new Error(`Garmin OAuth2 failed (${r4.status})`);

    const profileRes = await this.http.get(`${GARMIN_BASE}/userprofile-service/socialProfile`, {
      headers: { Authorization: `Bearer ${r4.data.access_token}`, 'User-Agent': UA_MOBILE },
    });
    this.displayName = profileRes.data?.displayName || profileRes.data?.userName || process.env.GARMIN_EMAIL.split('@')[0];
    this.accessToken = r4.data.access_token;
    this.tokenExpiry = Date.now() / 1000 + r4.data.expires_in;
    fs.writeFileSync(GARMIN_TOKEN_FILE, JSON.stringify({ access_token: this.accessToken, expires_at: this.tokenExpiry, displayName: this.displayName }));
    console.log('Garmin login complete, displayName:', this.displayName);
  }

  async _get(urlPath) {
    const token = await this.getToken();
    const res = await this.http.get(`${GARMIN_BASE}${urlPath}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA_MOBILE },
    });
    if (res.status !== 200) throw new Error(`Garmin API ${urlPath.slice(0,50)}: ${res.status}`);
    return res.data;
  }

  getSleepData(dateStr)    { return this._get(`/sleep-service/sleep/dailySleepData?date=${dateStr}`); }
  getHeartRate(dateStr)    { return this._get(`/wellness-service/wellness/dailyHeartRate?date=${dateStr}`); }
  getSteps(dateStr)        { return this._get(`/usersummary-service/stats/steps/daily/${dateStr}/${dateStr}`); }
  getHRV(dateStr)          { return this._get(`/hrv-service/hrv/${dateStr}`); }
  getDailySummary(dateStr) { return this._get(`/usersummary-service/usersummary/daily/${this.displayName}?calendarDate=${dateStr}`); }
  getSpO2(dateStr)         { return this._get(`/wellness-service/wellness/dailyOximetry/${this.displayName}?calendarDate=${dateStr}`); }
  getRespiration(dateStr)  { return this._get(`/wellness-service/wellness/dailyRespiration/${this.displayName}?calendarDate=${dateStr}`); }
}

const garmin = new GarminClient();

const SYSTEM_PROMPT = `You are a personal fitness coach assistant. You have access to the user's real training and recovery data from Garmin and Strava. Be concise, specific, and practical. Always reference actual numbers from the data in your response.`;

// --- STRAVA TOKEN MANAGEMENT ---

function loadStravaTokens() {
  try {
    return JSON.parse(fs.readFileSync(STRAVA_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveStravaTokens(tokens) {
  fs.writeFileSync(STRAVA_TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshStravaToken(tokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });
    const req = https.request({
      hostname: 'www.strava.com',
      path: '/api/v3/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.access_token) {
            saveStravaTokens(data);
            resolve(data.access_token);
          } else {
            reject(new Error(`Token refresh failed: ${JSON.stringify(data)}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getStravaToken() {
  const tokens = loadStravaTokens();
  if (!tokens) throw new Error('Strava not connected. Ask admin to run strava-setup.js');
  if (Date.now() / 1000 > tokens.expires_at - 300) {
    return refreshStravaToken(tokens);
  }
  return tokens.access_token;
}

async function stravaGet(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.strava.com',
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- GARMIN AUTH ---

async function loginGarmin() {
  await garmin.getToken(); // loads from cache or does full OAuth2 login
}

// --- HELPERS ---

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function toHM(sec) {
  if (!sec && sec !== 0) return 'N/A';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// --- SYNC FUNCTIONS ---

// Fetch last 10 Strava activities and upsert to activities table
// Table columns: activity_id, name, type, date, distance, duration, calories, average_hr, max_hr, source, raw
async function syncStrava() {
  const token = await getStravaToken();
  const activities = await stravaGet('/api/v3/athlete/activities?per_page=10', token);

  if (!Array.isArray(activities)) {
    throw new Error(`Unexpected Strava response: ${JSON.stringify(activities).slice(0, 200)}`);
  }

  const rows = activities.map((a) => ({
    activity_id: String(a.id),
    name: a.name,
    type: a.sport_type || a.type || 'Unknown',
    date: a.start_date,
    distance: a.distance || null,
    duration: a.moving_time || null,
    calories: a.calories || null,
    average_hr: a.average_heartrate || null,
    max_hr: a.max_heartrate || null,
    source: 'strava',
    raw: JSON.stringify(a),
  }));

  for (const row of rows) {
    const { error } = await supabase.from('activities').upsert(row, { onConflict: 'activity_id' });
    if (error) console.error('Supabase upsert error (activities):', error.message);
  }

  return rows.length;
}

async function syncGarminForDate(dateStr) {
  await loginGarmin(); // ensures token + displayName are loaded

  const [sleepRes, hrRes, stepsRes, hrvRes] = await Promise.allSettled([
    garmin.getSleepData(dateStr),
    garmin.getHeartRate(dateStr),
    garmin.getSteps(dateStr),
    garmin.getHRV(dateStr),
  ]);

  let summaryRaw = null, spo2Raw = null, respirationRaw = null;
  try { summaryRaw    = await garmin.getDailySummary(dateStr); } catch (e) { console.error('Garmin summary:', e.message); }
  try { spo2Raw       = await garmin.getSpO2(dateStr);         } catch (e) { console.error('Garmin SpO2:', e.message); }
  try { respirationRaw = await garmin.getRespiration(dateStr); } catch (e) { console.error('Garmin resp:', e.message); }

  const sleep = sleepRes.status === 'fulfilled' ? sleepRes.value : null;
  const hr    = hrRes.status    === 'fulfilled' ? hrRes.value    : null;
  const steps = stepsRes.status === 'fulfilled' ? stepsRes.value : null;
  const hrv   = hrvRes.status   === 'fulfilled' ? hrvRes.value   : null;
  const dto   = sleep?.dailySleepDTO || null;

  const totalSteps = Array.isArray(steps)
    ? steps.reduce((s, d) => s + (d.totalSteps || d.steps || 0), 0) || null
    : steps?.totalSteps ?? null;

  const row = {
    date: dateStr,
    sleep_score:         dto?.sleepScores?.overall?.value ?? dto?.sleepScore ?? null,
    sleep_deep_seconds:  dto?.deepSleepSeconds  ?? null,
    sleep_light_seconds: dto?.lightSleepSeconds ?? null,
    sleep_rem_seconds:   dto?.remSleepSeconds   ?? null,
    sleep_awake_seconds: dto?.awakeSleepSeconds ?? null,
    hrv_weekly_avg:      hrv?.hrv?.hrvSummary?.weeklyAvg ?? hrv?.hrvSummary?.weeklyAvg ?? dto?.averageHRV ?? null,
    body_battery_high:   summaryRaw?.bodyBatteryHighestValue ?? null,
    body_battery_low:    summaryRaw?.bodyBatteryLowestValue  ?? null,
    resting_hr:          hr?.restingHeartRate ?? summaryRaw?.restingHeartRate ?? null,
    avg_stress:          summaryRaw?.averageStressLevel ?? dto?.averageStressLevel ?? null,
    spo2_avg:            spo2Raw?.averageSpO2 ?? spo2Raw?.avgSpO2 ?? null,
    steps:               totalSteps,
    intensity_minutes:   (summaryRaw?.moderateIntensityMinutes ?? 0) + (summaryRaw?.vigorousIntensityMinutes ?? 0) || null,
    respiration_avg:     respirationRaw?.avgWakingRespirationValue ?? respirationRaw?.avgRespirationValue ?? null,
    raw: JSON.stringify({ dto, hr, hrv, summary: summaryRaw }),
  };

  const { error } = await supabase.from('wellness').upsert(row, { onConflict: 'date' });
  if (error) throw new Error(`Supabase wellness upsert failed: ${error.message}`);

  return row;
}

// --- COMMAND HANDLERS ---

// /sync — fetch last 10 Strava activities + yesterday's Garmin wellness data
bot.onText(/\/sync/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    let actCount = 0;
    try {
      actCount = await syncStrava();
    } catch (e) {
      console.error('Strava sync error:', e);
      await bot.sendMessage(chatId, `⚠️ Strava sync failed: ${e.message}`);
    }

    const today = new Date().toISOString().split('T')[0];
    const yday = yesterday();
    const datesToSync = today === yday ? [today] : [today, yday];
    const savedDates = [];

    for (const d of datesToSync) {
      try {
        await syncGarminForDate(d);
        savedDates.push(d);
      } catch (e) {
        console.error(`Garmin sync error (${d}):`, e);
        await bot.sendMessage(chatId, `⚠️ Garmin sync failed for ${d}: ${e.message}`);
      }
    }

    await bot.sendMessage(chatId, `Synced ${actCount} activities. Wellness data saved for: ${savedDates.join(', ') || 'none'}.`);
  } catch (err) {
    console.error('/sync error:', err);
    await bot.sendMessage(chatId, `❌ Sync failed: ${err.message}`);
  }
});

// /sleep — show most recent sleep data from wellness table
bot.onText(/\/sleep/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { data, error } = await supabase
      .from('wellness')
      .select('*')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      await bot.sendMessage(chatId, 'No wellness data found. Run /sync first.');
      return;
    }

    const total = (data.sleep_deep_seconds || 0) + (data.sleep_light_seconds || 0) +
                  (data.sleep_rem_seconds || 0) + (data.sleep_awake_seconds || 0);

    const reply = [
      `Sleep Report — ${data.date}`,
      `Score: ${data.sleep_score ?? 'N/A'}`,
      `Total: ${toHM(total)}`,
      `Deep: ${toHM(data.sleep_deep_seconds)}`,
      `Light: ${toHM(data.sleep_light_seconds)}`,
      `REM: ${toHM(data.sleep_rem_seconds)}`,
      `Awake: ${toHM(data.sleep_awake_seconds)}`,
      `HRV Weekly Avg: ${data.hrv_weekly_avg ?? 'N/A'} ms`,
      `Body Battery: ${data.body_battery_high ?? 'N/A'} high / ${data.body_battery_low ?? 'N/A'} low`,
    ].join('\n');

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('/sleep error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /stats — summarise last 7 days of activities grouped by type
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const cutoff = daysAgo(7);
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .gte('date', cutoff)
      .order('date', { ascending: false });

    if (error || !data || data.length === 0) {
      await bot.sendMessage(chatId, 'No activities in the last 7 days. Run /sync first.');
      return;
    }

    const byType = {};
    for (const a of data) {
      const t = a.type || 'Unknown';
      if (!byType[t]) byType[t] = { count: 0, distance: 0, duration: 0, hrTotal: 0, hrCount: 0 };
      byType[t].count++;
      byType[t].distance += a.distance || 0;
      byType[t].duration += a.duration || 0;
      if (a.average_hr) { byType[t].hrTotal += a.average_hr; byType[t].hrCount++; }
    }

    let reply = `Activity Summary — Last 7 Days\nTotal workouts: ${data.length}\n\n`;
    for (const [type, s] of Object.entries(byType)) {
      const distKm = (s.distance / 1000).toFixed(1);
      const durationMin = Math.round(s.duration / 60);
      const avgHR = s.hrCount ? Math.round(s.hrTotal / s.hrCount) : 'N/A';
      reply += `${type}: ${s.count} session(s)\n  Distance: ${distKm} km  Duration: ${durationMin} min  Avg HR: ${avgHR}\n\n`;
    }

    await bot.sendMessage(chatId, reply.trim());
  } catch (err) {
    console.error('/stats error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /recovery — show recovery metrics and ask Claude for a readiness summary
bot.onText(/\/recovery/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { data, error } = await supabase
      .from('wellness')
      .select('*')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      await bot.sendMessage(chatId, 'No wellness data found. Run /sync first.');
      return;
    }

    const metrics = [
      `Recovery Metrics — ${data.date}`,
      `Body Battery: ${data.body_battery_high ?? 'N/A'} high / ${data.body_battery_low ?? 'N/A'} low`,
      `HRV Weekly Avg: ${data.hrv_weekly_avg ?? 'N/A'} ms`,
      `Avg Stress: ${data.avg_stress ?? 'N/A'}`,
      `Resting HR: ${data.resting_hr ?? 'N/A'} bpm`,
      `SpO2: ${data.spo2_avg ?? 'N/A'}%`,
    ].join('\n');

    const groqRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Based on this recovery data, provide a 2-3 sentence readiness summary and today's training recommendation:\n\n${metrics}` },
      ],
    });

    await bot.sendMessage(chatId, `${metrics}\n\n${groqRes.choices[0].message.content}`);
  } catch (err) {
    console.error('/recovery error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /ask [question] — answer a fitness question using Claude with full 7-day data context
bot.onText(/\/ask (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];
  try {
    const cutoff = daysAgo(7);
    const [activitiesRes, wellnessRes] = await Promise.all([
      supabase.from('activities').select('date,name,type,distance,duration,average_hr,max_hr,calories').gte('date', cutoff).order('date', { ascending: false }),
      supabase.from('wellness').select('date,sleep_score,sleep_deep_seconds,sleep_light_seconds,sleep_rem_seconds,hrv_weekly_avg,body_battery_high,body_battery_low,resting_hr,avg_stress,spo2_avg,steps,intensity_minutes').gte('date', cutoff).order('date', { ascending: false }),
    ]);

    const acts = (activitiesRes.data || []).map(a =>
      `${a.date?.slice(0,10)} ${a.type} "${a.name}" dist:${a.distance ? (a.distance/1000).toFixed(1)+'km' : 'N/A'} dur:${a.duration ? Math.round(a.duration/60)+'min' : 'N/A'} avgHR:${a.average_hr ?? 'N/A'}`
    ).join('\n');

    const well = (wellnessRes.data || []).map(w =>
      `${w.date} sleep:${w.sleep_score ?? 'N/A'} deepSleep:${w.sleep_deep_seconds ? Math.round(w.sleep_deep_seconds/60)+'min' : 'N/A'} HRV:${w.hrv_weekly_avg ?? 'N/A'} battery:${w.body_battery_high ?? 'N/A'}high/${w.body_battery_low ?? 'N/A'}low HR:${w.resting_hr ?? 'N/A'} stress:${w.avg_stress ?? 'N/A'} steps:${w.steps ?? 'N/A'}`
    ).join('\n');

    const context = `Recent Activities (last 7 days):\n${acts || 'none'}\n\nWellness (last 7 days):\n${well || 'none'}`;

    const groqRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${question}\n\nData context:\n${context}` },
      ],
    });

    await bot.sendMessage(chatId, groqRes.choices[0].message.content);
  } catch (err) {
    console.error('/ask error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /history [days] — backfill Garmin wellness for up to 30 days
bot.onText(/\/history ?(\d*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const days = Math.min(parseInt(match[1]) || 7, 30);
  let saved = 0;

  try {
    for (let i = 1; i <= days; i++) {
      const dateStr = daysAgo(i);
      try {
        await syncGarminForDate(dateStr);
        saved++;
        await bot.sendMessage(chatId, `✓ Saved ${dateStr} (${i}/${days})`);
      } catch (e) {
        console.error(`Error syncing ${dateStr}:`, e.message);
        await bot.sendMessage(chatId, `⚠️ Failed for ${dateStr}: ${e.message}`);
      }
    }
    await bot.sendMessage(chatId, `Backfill complete. ${saved} days saved.`);
  } catch (err) {
    console.error('/history error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// Note: only fires if Render keeps the service awake.
// On free tier use /sync manually or upgrade to Background Worker.
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Starting auto-sync...');
  try {
    const actCount = await syncStrava().catch(e => { console.error('[cron] Strava:', e.message); return 0; });
    const today = new Date().toISOString().split('T')[0];
    await syncGarminForDate(today).catch(e => console.error('[cron] Garmin today:', e.message));
    await syncGarminForDate(yesterday()).catch(e => console.error('[cron] Garmin yesterday:', e.message));
    console.log(`[cron] Auto-sync complete. ${actCount} activities synced.`);
  } catch (err) {
    console.error('[cron] Sync error:', err);
  }
});

// Health check server required by Render
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running.');
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Health check server on port ${process.env.PORT || 3000}`);
});

console.log('Fitness bot running. Commands: /sync /sleep /stats /recovery /ask /history');
