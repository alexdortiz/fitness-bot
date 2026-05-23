require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '.strava-tokens.json');
const PORT = 3000;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env');
  process.exit(1);
}

const authUrl =
  `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}` +
  `&redirect_uri=http://localhost:${PORT}/strava/callback` +
  `&response_type=code&approval_prompt=force&scope=read,activity:read_all`;

console.log('\n=== Strava OAuth Setup ===');
console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:' + PORT + '/strava/callback ...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/strava/callback')) {
    res.end('Not found');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.end('<h2>Authorization denied or failed.</h2>');
    console.error('OAuth error:', error || 'no code returned');
    server.close();
    return;
  }

  console.log('Got authorization code, exchanging for tokens...');

  try {
    const tokens = await exchangeCode(code);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('\n✓ Tokens saved to .strava-tokens.json');
    console.log('  Athlete:', tokens.athlete?.firstname, tokens.athlete?.lastname);
    console.log('  Expires:', new Date(tokens.expires_at * 1000).toLocaleString());
    res.end('<h2>✓ Strava connected! You can close this tab and run the bot.</h2>');
  } catch (e) {
    console.error('Token exchange failed:', e.message);
    res.end('<h2>Token exchange failed: ' + e.message + '</h2>');
  }

  server.close(() => process.exit(0));
});

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
    const req = https.request({
      hostname: 'www.strava.com',
      path: '/api/v3/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (!data.access_token) reject(new Error('No access_token: ' + raw.slice(0, 200)));
          else resolve(data);
        } catch (e) {
          reject(new Error('Parse error: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.listen(PORT);
