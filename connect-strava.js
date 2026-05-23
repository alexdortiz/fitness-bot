require('dotenv').config();
const https = require('https');

const API_KEY = process.env.COMPOSIO_API_KEY;
const BASE = 'backend.composio.dev';

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE,
      path,
      method,
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Check existing connection
  const listRes = await apiCall('GET', '/api/v1/connectedAccounts?appNames=strava&user_uuid=default&showActiveOnly=true');
  if (listRes.body?.items?.length > 0) {
    const conn = listRes.body.items[0];
    console.log('✓ Strava already connected! ID:', conn.id, 'Status:', conn.status);
    return;
  }

  // Check v3 auth configs
  console.log('Checking v3 auth configs for Strava...');
  const authConfigsRes = await apiCall('GET', '/api/v3/auth_configs?appName=strava&limit=10');
  console.log('Auth configs status:', authConfigsRes.status);
  console.log('Auth configs:', JSON.stringify(authConfigsRes.body, null, 2));

  const authConfigId = authConfigsRes.body?.items?.[0]?.id || authConfigsRes.body?.[0]?.id;
  if (authConfigId) {
    console.log('\nUsing auth config ID:', authConfigId);
    const linkRes = await apiCall('POST', '/api/v3/connected_accounts/link', {
      auth_config_id: authConfigId,
      user_id: 'default',
    });
    console.log('Link status:', linkRes.status);
    console.log('Link response:', JSON.stringify(linkRes.body, null, 2));

    const redirectUrl = linkRes.body?.redirectUrl || linkRes.body?.redirect_url ||
      linkRes.body?.data?.redirectUrl || linkRes.body?.data?.redirect_url;
    if (redirectUrl) {
      console.log('\n=== OPEN THIS URL IN YOUR BROWSER ===');
      console.log(redirectUrl);
    }
  } else {
    // Try creating a v3 auth config
    console.log('\nNo v3 auth config found. Creating one...');
    const createRes = await apiCall('POST', '/api/v3/auth_configs', {
      app_name: 'strava',
      use_composio_auth: true,
    });
    console.log('Create status:', createRes.status);
    console.log('Create response:', JSON.stringify(createRes.body, null, 2));

    const newAuthConfigId = createRes.body?.id || createRes.body?.data?.id;
    if (newAuthConfigId) {
      const linkRes = await apiCall('POST', '/api/v3/connected_accounts/link', {
        auth_config_id: newAuthConfigId,
        user_id: 'default',
      });
      console.log('Link status:', linkRes.status);
      console.log('Link response:', JSON.stringify(linkRes.body, null, 2));

      const redirectUrl = linkRes.body?.redirectUrl || linkRes.body?.redirect_url ||
        linkRes.body?.data?.redirectUrl || linkRes.body?.data?.redirect_url;
      if (redirectUrl) {
        console.log('\n=== OPEN THIS URL IN YOUR BROWSER ===');
        console.log(redirectUrl);
      }
    }
  }
}

main().catch(console.error);
