require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const code = process.argv[2];
if (!code) { console.error('Usage: node strava-exchange.js <code>'); process.exit(1); }

const body = JSON.stringify({
  client_id: process.env.STRAVA_CLIENT_ID,
  client_secret: process.env.STRAVA_CLIENT_SECRET,
  code,
  grant_type: 'authorization_code',
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
    const data = JSON.parse(raw);
    if (!data.access_token) { console.error('Failed:', raw); process.exit(1); }
    fs.writeFileSync(path.join(__dirname, '.strava-tokens.json'), JSON.stringify(data, null, 2));
    console.log('✓ Tokens saved!');
    console.log('  Athlete:', data.athlete?.firstname, data.athlete?.lastname);
    console.log('  Expires:', new Date(data.expires_at * 1000).toLocaleString());
  });
});
req.on('error', console.error);
req.write(body);
req.end();
