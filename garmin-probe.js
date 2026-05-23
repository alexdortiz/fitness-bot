require('dotenv').config();
const axios = require('axios');
const qs = require('qs');

const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const SIGNIN_URL = 'https://sso.garmin.com/sso/signin';

// Simple cookie jar
class CookieJar {
  constructor() { this.cookies = {}; }
  set(setCookieHeaders) {
    for (const h of (setCookieHeaders || [])) {
      const [kv] = h.split(';');
      const [k, v] = kv.split('=');
      this.cookies[k.trim()] = v ? v.trim() : '';
    }
  }
  header() { return Object.entries(this.cookies).map(([k,v]) => `${k}=${v}`).join('; '); }
}

async function probe() {
  const jar = new CookieJar();
  const inst = axios.create({ maxRedirects: 5, validateStatus: () => true });

  const params = {
    id: 'gauth-widget', embedWidget: 'true', locale: 'en',
    gauthHost: SSO_EMBED, service: SSO_EMBED, source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  };
  const baseUrl = SIGNIN_URL + '?' + qs.stringify(params);

  // Step 1: GET signin to get CSRF + session cookies
  const r1 = await inst.get(baseUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
  });
  jar.set(r1.headers['set-cookie']);

  const csrfMatch = r1.data.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : null;
  const title1 = (r1.data.match(/<title>([^<]+)/) || [])[1];
  console.log('Step1:', r1.status, title1, '| CSRF:', csrf ? 'OK' : 'MISSING');
  console.log('Cookies after step1:', jar.header().slice(0, 100));
  if (!csrf) return;

  // Step 2: POST credentials as URL-encoded (not multipart)
  const body = qs.stringify({
    username: process.env.GARMIN_EMAIL,
    password: process.env.GARMIN_PASSWORD,
    embed: 'true',
    _csrf: csrf,
  });

  const r2 = await inst.post(baseUrl, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
      Origin: 'https://sso.garmin.com',
      Referer: baseUrl,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Dnt: '1',
    }
  });
  jar.set(r2.headers['set-cookie']);

  const title2 = (r2.data.match(/<title>([^<]+)/) || [])[1];
  const ticketMatch = r2.data.match(/ticket=([^"&\s<]+)/);
  const ticket = ticketMatch ? ticketMatch[1] : null;
  console.log('Step2:', r2.status, title2, '| Ticket:', ticket ? 'FOUND ✓' : 'NOT FOUND');
  if (ticket) {
    console.log('Ticket:', ticket.slice(0, 40) + '...');
  } else {
    // Print relevant snippet to understand what Garmin returned
    const body2 = String(r2.data);
    const errMatch = body2.match(/class="error[^>]*>([^<]+)/i);
    const msgMatch = body2.match(/id="status"[^>]*>([^<]+)/i);
    console.log('Error msg in page:', errMatch ? errMatch[1].trim() : 'none');
    console.log('Status msg in page:', msgMatch ? msgMatch[1].trim() : 'none');
    console.log('Snippet:', body2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400));
  }
}

probe().catch(e => console.error('Fatal:', e.message));
