require('dotenv').config();
const https = require('https');

const PROJECT_REF = 'vinnjldkangzragjuscy';

const ACTIVITIES_SQL = `
CREATE TABLE IF NOT EXISTS activities (
  id BIGSERIAL PRIMARY KEY,
  activity_id TEXT UNIQUE NOT NULL,
  name TEXT,
  sport_type TEXT,
  start_date TIMESTAMPTZ,
  distance FLOAT,
  moving_time INTEGER,
  elapsed_time INTEGER,
  average_heartrate FLOAT,
  max_heartrate FLOAT,
  total_elevation_gain FLOAT,
  average_speed FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const WELLNESS_SQL = `
CREATE TABLE IF NOT EXISTS wellness (
  id BIGSERIAL PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  sleep_score INTEGER,
  sleep_seconds_total INTEGER,
  sleep_deep_seconds INTEGER,
  sleep_light_seconds INTEGER,
  sleep_rem_seconds INTEGER,
  sleep_awake_seconds INTEGER,
  hrv_weekly_avg FLOAT,
  body_battery_high INTEGER,
  body_battery_low INTEGER,
  resting_hr INTEGER,
  avg_stress INTEGER,
  spo2 FLOAT,
  steps INTEGER,
  intensity_minutes INTEGER,
  respiration_avg FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

function runSQL(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Creating activities table...');
  const r1 = await runSQL(ACTIVITIES_SQL);
  console.log('Activities:', r1.status, JSON.stringify(r1.body).slice(0, 200));

  console.log('Creating wellness table...');
  const r2 = await runSQL(WELLNESS_SQL);
  console.log('Wellness:', r2.status, JSON.stringify(r2.body).slice(0, 200));

  if (r1.status === 200 && r2.status === 200) {
    console.log('\n✓ Both tables created successfully.');
  } else {
    console.log('\n⚠ Management API may require a personal access token.');
    console.log('Run this SQL in your Supabase dashboard (https://supabase.com/dashboard/project/vinnjldkangzragjuscy/sql):');
    console.log('\n---ACTIVITIES TABLE---');
    console.log(ACTIVITIES_SQL);
    console.log('\n---WELLNESS TABLE---');
    console.log(WELLNESS_SQL);
  }
}

main().catch(console.error);
