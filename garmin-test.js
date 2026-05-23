require('dotenv').config();
const axios = require('axios');
const qs = require('qs');

class GarminClient {
  constructor() {
    this.cookies = {};
    this.displayName = null;
    this.http = axios.create({ maxRedirects: 10, validateStatus: () => true });
  }
  _setCookies(headers) {
    for (const h of (headers || [])) {
      const [kv] = h.split(';');
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      this.cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }
  _cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async login(email, password) {
    const CONNECT_AUTH = 'https://connect.garmin.com/modern/auth/sso/login';
    const signinUrl = 'https://sso.garmin.com/sso/signin?' + qs.stringify({
      id: 'gauth-widget', embedWidget: 'false', locale: 'en_US',
      gauthHost: 'https://sso.garmin.com/sso',
      service: CONNECT_AUTH, source: CONNECT_AUTH,
      redirectAfterAccountLoginUrl: CONNECT_AUTH,
      redirectAfterAccountCreationUrl: CONNECT_AUTH,
    });
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const r1 = await this.http.get(signinUrl, { headers: { 'User-Agent': ua } });
    this._setCookies(r1.headers['set-cookie']);
    const csrfMatch = String(r1.data).match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) throw new Error('No CSRF token');
    const r2 = await this.http.post(signinUrl,
      qs.stringify({ username: email, password, embed: 'false', _csrf: csrfMatch[1] }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(), 'Origin': 'https://sso.garmin.com', 'Referer': signinUrl, 'User-Agent': ua } }
    );
    this._setCookies(r2.headers['set-cookie']);
    const ticketMatch = String(r2.data).match(/ticket=([A-Za-z0-9_-]+)/);
    if (!ticketMatch) throw new Error('No ticket');
    // Manually follow redirects to capture session cookies at each hop
    let nextUrl = `${CONNECT_AUTH}?ticket=${ticketMatch[1]}`;
    for (let i = 0; i < 7; i++) {
      const r = await this.http.get(nextUrl, {
        maxRedirects: 0,
        headers: { 'Cookie': this._cookieHeader(), 'User-Agent': ua },
      });
      this._setCookies(r.headers['set-cookie']);
      console.log(`Redirect ${i}: status=${r.status} location=${r.headers.location || '(none)'} cookies=${Object.keys(this.cookies).join(',')}`);
      if ([301, 302, 303].includes(r.status) && r.headers.location) {
        nextUrl = r.headers.location;
        if (nextUrl.startsWith('/')) nextUrl = 'https://connect.garmin.com' + nextUrl;
      } else {
        break;
      }
    }
    const profile = await this._get('https://connect.garmin.com/proxy/userprofile-service/socialProfile');
    console.log('Profile keys:', Object.keys(profile));
    console.log('displayName:', profile.displayName);
    console.log('userName:', profile.userName);
    this.displayName = profile.displayName || profile.userName || email.split('@')[0];
    console.log('Using displayName:', this.displayName);
  }
  async _get(url) {
    const res = await this.http.get(url, {
      headers: {
        'Cookie': this._cookieHeader(),
        'NK': 'NT',
        'Accept': 'application/json, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    });
    this._setCookies(res.headers['set-cookie']);
    if (res.status !== 200) throw new Error(`ERROR: (${res.status}), ${JSON.stringify(res.data).slice(0, 200)}`);
    if (typeof res.data === 'string') return JSON.parse(res.data);
    return res.data;
  }
}

async function main() {
  const client = new GarminClient();
  console.log('Logging in...');
  await client.login(process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD);
  console.log('\n--- Fetching sleep data ---');
  const dateStr = '2026-05-22';
  try {
    const sleep = await client._get(`https://connect.garmin.com/proxy/wellness-service/wellness/dailySleepData/${client.displayName}?date=${dateStr}&nonSleepBufferMinutes=60`);
    console.log('Sleep top-level keys:', Object.keys(sleep || {}));
    const dto = sleep?.dailySleepDTO;
    console.log('dailySleepDTO keys:', dto ? Object.keys(dto) : 'NULL');
    if (dto) {
      console.log('deepSleepSeconds:', dto.deepSleepSeconds);
      console.log('lightSleepSeconds:', dto.lightSleepSeconds);
      console.log('remSleepSeconds:', dto.remSleepSeconds);
      console.log('sleepScores:', JSON.stringify(dto.sleepScores));
    }
  } catch (e) { console.error('Sleep fetch error:', e.message); }

  console.log('\n--- Fetching daily summary ---');
  try {
    const summary = await client._get(`https://connect.garmin.com/proxy/usersummary-service/usersummary/daily/${client.displayName}?calendarDate=${dateStr}`);
    console.log('Summary keys:', Object.keys(summary || {}));
    console.log('totalSteps:', summary?.totalSteps);
    console.log('restingHeartRate:', summary?.restingHeartRate);
    console.log('averageStressLevel:', summary?.averageStressLevel);
    console.log('maxBodyBattery:', summary?.maxBodyBattery);
    console.log('minBodyBattery:', summary?.minBodyBattery);
  } catch (e) { console.error('Summary fetch error:', e.message); }
}

main().catch(console.error);
