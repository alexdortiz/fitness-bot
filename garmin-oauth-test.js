require('dotenv').config();
const axios = require('axios');
const qs = require('qs');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');

const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const SIGNIN_URL = 'https://sso.garmin.com/sso/signin';
const OAUTH_URL = 'https://connectapi.garmin.com/oauth-service/oauth';
const UA_MOBILE = 'com.garmin.android.apps.connectmobile';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

async function main() {
  const http = axios.create({ maxRedirects: 5, validateStatus: () => true });
  const cookies = {};
  const setCookies = (h) => {
    for (const c of (h || [])) {
      const [kv] = c.split(';');
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  };
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  // Step 1: Fetch consumer keys
  console.log('Fetching OAuth consumer keys from S3...');
  const consumerRes = await axios.get('https://thegarth.s3.amazonaws.com/oauth_consumer.json');
  const consumer = { key: consumerRes.data.consumer_key, secret: consumerRes.data.consumer_secret };
  console.log('Consumer key (first 8):', consumer.key?.slice(0, 8));
  console.log('Consumer secret (first 8):', consumer.secret?.slice(0, 8));

  // Step 2: SSO login using embed service
  console.log('\nSSO login...');
  const signinParams = qs.stringify({
    id: 'gauth-widget', embedWidget: 'true', locale: 'en',
    gauthHost: SSO_EMBED, service: SSO_EMBED, source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED, redirectAfterAccountCreationUrl: SSO_EMBED,
  });
  const signinUrl = `${SIGNIN_URL}?${signinParams}`;
  const r1 = await http.get(signinUrl, { headers: { 'User-Agent': UA_BROWSER } });
  setCookies(r1.headers['set-cookie']);
  const csrfMatch = String(r1.data).match(/name="_csrf"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('No CSRF token');

  const r2 = await http.post(signinUrl,
    qs.stringify({ username: process.env.GARMIN_EMAIL, password: process.env.GARMIN_PASSWORD, embed: 'true', _csrf: csrfMatch[1] }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(), Origin: 'https://sso.garmin.com', Referer: signinUrl, 'User-Agent': UA_BROWSER } }
  );
  setCookies(r2.headers['set-cookie']);
  const ticketMatch = String(r2.data).match(/ticket=([^"&\s<]+)/);
  if (!ticketMatch) throw new Error('No ticket from SSO');
  const ticket = ticketMatch[1];
  console.log('Ticket (first 20):', ticket.slice(0, 20));

  // Step 3: OAuth1 exchange
  console.log('\nOAuth1 token exchange...');
  const oauth = new OAuth({
    consumer,
    signature_method: 'HMAC-SHA1',
    hash_function: (base, key) => crypto.createHmac('sha1', key).update(base).digest('base64'),
  });
  const preAuthUrl = `${OAUTH_URL}/preauthorized?` + qs.stringify({
    ticket, 'login-url': SSO_EMBED, 'accepts-mfa-tokens': true,
  });
  const authHeader = oauth.toHeader(oauth.authorize({ url: preAuthUrl, method: 'GET' }));
  console.log('Calling:', preAuthUrl.slice(0, 80) + '...');
  const r3 = await http.get(preAuthUrl, {
    headers: { ...authHeader, 'User-Agent': UA_MOBILE },
  });
  console.log('OAuth1 status:', r3.status);
  console.log('OAuth1 response:', String(r3.data).slice(0, 300));

  if (r3.status !== 200) { console.error('OAuth1 exchange failed'); return; }

  const oauth1Token = qs.parse(String(r3.data));
  console.log('oauth_token (first 10):', String(oauth1Token.oauth_token || '').slice(0, 10));

  // Step 4: OAuth2 exchange — params go in query string only (no Authorization header)
  console.log('\nOAuth2 token exchange...');
  const token = { key: oauth1Token.oauth_token, secret: oauth1Token.oauth_token_secret };
  const exchangeUrl = `${OAUTH_URL}/exchange/user/2.0`;
  const step4Params = oauth.authorize({ url: exchangeUrl, method: 'POST' }, token);
  const fullExchangeUrl = `${exchangeUrl}?${qs.stringify(step4Params)}`;
  const r4 = await http.post(fullExchangeUrl, null, {
    headers: { 'User-Agent': UA_MOBILE, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  console.log('OAuth2 status:', r4.status);
  if (r4.status === 200) {
    console.log('access_token (first 20):', String(r4.data?.access_token || '').slice(0, 20));
    console.log('expires_in:', r4.data?.expires_in);

    const bearer = r4.data.access_token;
    const displayName = (await http.get('https://connectapi.garmin.com/userprofile-service/socialProfile', {
      headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': UA_MOBILE },
    })).data?.displayName;
    console.log('displayName:', displayName);

    const dateStr = '2026-05-23';
    const apiGet = async (path) => {
      const res = await http.get(`https://connectapi.garmin.com${path}`, {
        headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': UA_MOBILE },
      });
      return { status: res.status, data: res.data };
    };

    console.log('\n--- Daily Summary ---');
    const s = await apiGet(`/usersummary-service/usersummary/daily/${displayName}?calendarDate=${dateStr}`);
    console.log('Status:', s.status);
    if (s.status === 200) {
      const d = s.data;
      console.log('totalSteps:', d.totalSteps);
      console.log('restingHeartRate:', d.restingHeartRate);
      console.log('averageStressLevel:', d.averageStressLevel);
      console.log('bodyBatteryHighLevel:', d.bodyBatteryHighLevel);
      console.log('bodyBatteryLowLevel:', d.bodyBatteryLowLevel);
      console.log('maxBodyBattery:', d.maxBodyBattery);
      console.log('minBodyBattery:', d.minBodyBattery);
      console.log('All keys:', Object.keys(d).filter(k => k.toLowerCase().includes('battery') || k.toLowerCase().includes('stress') || k.toLowerCase().includes('heart')));
    } else {
      console.log('Response:', JSON.stringify(s.data).slice(0, 200));
    }

    console.log('\n--- Body Battery endpoint ---');
    const bb = await apiGet(`/wellness-service/wellness/dailyBodyBattery?startDate=${dateStr}&endDate=${dateStr}`);
    console.log('Status:', bb.status);
    console.log('Response (first 300):', JSON.stringify(bb.data).slice(0, 300));
  } else {
    console.error('OAuth2 failed:', String(r4.data).slice(0, 300));
  }
}

main().catch(e => console.error('Fatal:', e.message));
