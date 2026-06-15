'use strict';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const readline = require('readline');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.BRIDGE_PORT || '3333', 10);

// ─── MCP Client ──────────────────────────────────────────────────────────────
class GarminMCPClient {
  constructor() {
    this._proc = null;
    this._rl = null;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._msgId = 1;
    this._ready = false;
  }

  _nextId() {
    return this._msgId++;
  }

  _send(obj) {
    if (!this._proc || !this._proc.stdin.writable) {
      throw new Error('MCP process not running');
    }
    const line = JSON.stringify(obj) + '\n';
    this._proc.stdin.write(line);
  }

  _onLine(line) {
    line = line.trim();
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // ignore non-JSON output (e.g. startup messages)
      return;
    }

    const id = msg.id;
    if (id == null) return; // notifications — ignore

    const pending = this._pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pending.delete(id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }

  _request(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async initialize() {
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'garmin-bridge', version: '1.0.0' }
    });
    // send initialized notification (no id, no response expected)
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this._ready = true;
  }

  async tool(name, args = {}) {
    const result = await this._request('tools/call', { name, arguments: args });

    // MCP returns: { content: [{ type: 'text', text: '...' }] }
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      return null;
    }

    const text = result.content[0].text;
    if (!text) return null;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    // Some tools return { "error": "..." } in the content text
    if (parsed && typeof parsed === 'object' && parsed.error) {
      console.warn(`[MCP] Tool "${name}" returned error: ${parsed.error}`);
      return null;
    }

    return parsed;
  }

  spawn() {
    console.log('[bridge] Spawning Garmin MCP process...');
    this._proc = spawn('npx', ['-y', '@nicolasvegam/garmin-connect-mcp'], {
      env: {
        ...process.env,
        GARMIN_EMAIL: process.env.GARMIN_EMAIL || '',
        GARMIN_PASSWORD: process.env.GARMIN_PASSWORD || ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', (line) => this._onLine(line));

    this._proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[MCP stderr]', msg);
    });

    this._proc.on('exit', (code, signal) => {
      console.warn(`[bridge] MCP process exited (code=${code}, signal=${signal}). Restarting in 3 s...`);
      this._ready = false;
      // Reject all pending requests
      for (const [id, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('MCP process died'));
      }
      this._pending.clear();
      // Restart
      setTimeout(() => {
        this.spawn();
        this.initialize().catch((err) => console.error('[bridge] Re-init failed:', err));
      }, 3000);
    });

    this._proc.on('error', (err) => {
      console.error('[bridge] MCP process error:', err.message);
    });
  }

  get ready() {
    return this._ready;
  }
}

// ─── Instantiate & boot ───────────────────────────────────────────────────────
const mcp = new GarminMCPClient();

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'null'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json());

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', garminConnected: mcp.ready });
});

// ── Daily summary ─────────────────────────────────────────────────────────────
app.get('/api/summary', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [dailySummary, steps, bodyBattery, trainingReadiness] = await Promise.allSettled([
      mcp.tool('get_daily_summary', { date: today }),
      mcp.tool('get_steps', { date: today }),
      mcp.tool('get_body_battery', { date: today }),
      mcp.tool('get_training_readiness', { date: today })
    ]);

    const summary = dailySummary.status === 'fulfilled' ? dailySummary.value : null;
    const stepsData = steps.status === 'fulfilled' ? steps.value : null;
    const batteryData = bodyBattery.status === 'fulfilled' ? bodyBattery.value : null;
    const readinessData = trainingReadiness.status === 'fulfilled' ? trainingReadiness.value : null;

    res.json({
      date: today,
      steps: stepsData?.totalSteps ?? stepsData?.steps ?? summary?.totalSteps ?? 0,
      restingHR: summary?.restingHeartRate ?? summary?.resting_heart_rate ?? 0,
      bodyBattery: batteryData?.bodyBatteryMostRecentValue ?? batteryData?.charged ?? batteryData?.level ?? 0,
      stressLevel: summary?.averageStressLevel ?? summary?.average_stress_level ?? 0,
      trainingReadiness: readinessData?.score ?? readinessData?.trainingReadinessScore ?? 0
    });
  } catch (err) {
    console.error('[/api/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Last activity ─────────────────────────────────────────────────────────────
app.get('/api/last-activity', async (_req, res) => {
  try {
    const data = await mcp.tool('get_last_activity', {});
    if (!data) return res.json({});
    res.json(data);
  } catch (err) {
    console.error('[/api/last-activity]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Activities list ───────────────────────────────────────────────────────────
app.get('/api/activities', async (_req, res) => {
  try {
    const data = await mcp.tool('get_activities', { limit: 10 });
    res.json(Array.isArray(data) ? data : (data?.activities ?? []));
  } catch (err) {
    console.error('[/api/activities]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Recommendations ───────────────────────────────────────────────────────────
app.get('/api/recommendations', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [readinessResult, hrvResult, batteryResult] = await Promise.allSettled([
      mcp.tool('get_training_readiness', { date: today }),
      mcp.tool('get_hrv', { date: today }),
      mcp.tool('get_body_battery', { date: today })
    ]);

    const readinessData = readinessResult.status === 'fulfilled' ? readinessResult.value : null;
    const hrvData = hrvResult.status === 'fulfilled' ? hrvResult.value : null;
    const batteryData = batteryResult.status === 'fulfilled' ? batteryResult.value : null;

    const readiness = readinessData?.score ?? readinessData?.trainingReadinessScore ?? null;
    const battery = batteryData?.bodyBatteryMostRecentValue ?? batteryData?.charged ?? batteryData?.level ?? null;
    const hrv = hrvData?.lastNight ?? hrvData?.hrvLastNight ?? null;

    const recs = [];

    if (readiness !== null) {
      if (readiness < 40) {
        recs.push('Your training readiness is low — prioritise active recovery or rest today.');
      } else if (readiness < 60) {
        recs.push('Moderate training readiness. Consider a light aerobic session or easy run.');
      } else {
        recs.push('Great training readiness! This is a good day for a quality workout or long run.');
      }
    } else {
      recs.push('Training readiness data unavailable. Listen to your body and keep intensity moderate.');
    }

    if (battery !== null) {
      if (battery < 30) {
        recs.push('Body Battery is critically low — rest, hydrate, and avoid strenuous exercise today.');
      } else if (battery < 50) {
        recs.push('Body Battery is below 50. Focus on recovery: sleep early and limit stress.');
      } else {
        recs.push(`Body Battery is at ${battery}% — you have enough energy reserves for a solid session.`);
      }
    } else {
      recs.push('Keep your body battery topped up by aiming for 7–9 hours of quality sleep tonight.');
    }

    if (hrv !== null) {
      if (hrv < 30) {
        recs.push('HRV is suppressed — your nervous system needs recovery. Skip hard intervals today.');
      } else if (hrv > 60) {
        recs.push(`HRV of ${hrv} ms indicates excellent recovery. You are primed for high-intensity work.`);
      } else {
        recs.push(`HRV of ${hrv} ms is within a normal range. Steady-state training is appropriate.`);
      }
    } else {
      recs.push('Stay consistent with your training schedule and log workouts to unlock HRV trends.');
    }

    // Always add a fourth general tip
    recs.push('Remember to include at least 10 minutes of dynamic warm-up before any hard effort.');

    res.json(recs);
  } catch (err) {
    console.error('[/api/recommendations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Race Predictions ──────────────────────────────────────────────────────────
function formatSeconds(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

app.get('/api/race-predictions', async (_req, res) => {
  try {
    const data = await mcp.tool('get_race_predictions', {});
    if (!data) return res.status(502).json({ error: 'No data from MCP' });

    // MCP returns times in seconds; field names may vary — try common shapes
    const raw5k   = data['5k']   ?? data['5K']   ?? data.fiveK   ?? data.race5K   ?? null;
    const raw10k  = data['10k']  ?? data['10K']  ?? data.tenK    ?? data.race10K  ?? null;
    const rawHM   = data['halfMarathon'] ?? data['half_marathon'] ?? data.halfMarathon ?? data.raceHalfMarathon ?? null;
    const rawFull = data['marathon']     ?? data['full_marathon'] ?? data.marathon     ?? data.raceMarathon     ?? null;

    res.json({
      '5k':           { seconds: Math.round(raw5k   ?? 1168), formatted: formatSeconds(raw5k   ?? 1168) },
      '10k':          { seconds: Math.round(raw10k  ?? 2429), formatted: formatSeconds(raw10k  ?? 2429) },
      halfMarathon:   { seconds: Math.round(rawHM   ?? 5688), formatted: formatSeconds(rawHM   ?? 5688) },
      marathon:       { seconds: Math.round(rawFull ?? 12771), formatted: formatSeconds(rawFull ?? 12771) }
    });
  } catch (err) {
    console.error('[/api/race-predictions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Personal Records ───────────────────────────────────────────────────────────
const TYPE_ID_MAP = {
  1: 'fastest1k',
  2: 'fastest1mi',
  3: 'fastest5k',
  4: 'fastest10k',
  5: 'fastestHalfMarathon',
  7: 'longestRunMeters'
};

app.get('/api/personal-records', async (_req, res) => {
  try {
    const data = await mcp.tool('get_personal_records', {});
    const records = Array.isArray(data) ? data : (data?.personalRecords ?? data?.records ?? []);

    const result = {};

    for (const rec of records) {
      const typeId = rec.typeId ?? rec.type_id;
      const key = TYPE_ID_MAP[typeId];
      if (!key) continue;

      const value = rec.value ?? rec.personalRecordValue ?? rec.recordValue ?? 0;
      const actName = rec.activityName ?? rec.activity_name ?? rec.actStartDateTimeInGMTFormatted ?? '';
      const rawDate = rec.actStartDateTimeInGMTFormatted ?? rec.date ?? rec.actStartDateTimeLocalFormatted ?? '';
      const date = typeof rawDate === 'string' ? rawDate.slice(0, 10) : '';

      if (key === 'longestRunMeters') {
        result.longestRunKm = Math.round(value / 100) / 10;
      } else {
        const secs = Math.round(value);
        result[key] = {
          seconds: secs,
          formatted: formatSeconds(secs),
          activity: actName,
          date
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[/api/personal-records]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Training Week ─────────────────────────────────────────────────────────────
const TRAINING_PLANS = {
  half_marathon: {
    goal: 'half_marathon',
    targetTime: '1:28:00',
    currentPrediction: '1:34:48',
    weekPlan: [
      { day: 'Monday',   type: 'rest',     label: 'Rest / Mobility',    description: 'Full rest or 20min mobility work',                             duration: '20 min',   zone: null },
      { day: 'Tuesday',  type: 'quality',  label: 'Tempo Run',          description: '2km warm-up + 5×1km at 4:45/km + 1km cool-down',             duration: '55 min',   zone: 'Z3-Z4' },
      { day: 'Wednesday',type: 'easy',     label: 'Easy Run',           description: '8km at conversational pace (5:30–6:00/km)',                   duration: '45 min',   zone: 'Z2' },
      { day: 'Thursday', type: 'strength', label: 'Strength + Drills',  description: '30min lower body strength + 15min running drills',           duration: '45 min',   zone: null },
      { day: 'Friday',   type: 'rest',     label: 'Rest',               description: 'Complete rest. Focus on hydration and sleep.',                duration: '—',        zone: null },
      { day: 'Saturday', type: 'quality',  label: 'Interval Session',   description: '6×800m at 4:30/km with 90s recovery jog',                    duration: '50 min',   zone: 'Z4-Z5' },
      { day: 'Sunday',   type: 'long',     label: 'Long Run',           description: '18km at easy pace (5:30–5:50/km). Build to race distance.',  duration: '1h 45min', zone: 'Z2' }
    ]
  },
  marathon: {
    goal: 'marathon',
    targetTime: '3:20:00',
    currentPrediction: '3:32:51',
    weekPlan: [
      { day: 'Monday',   type: 'rest',     label: 'Rest / Mobility',    description: 'Full rest or 20min mobility work',                              duration: '20 min',   zone: null },
      { day: 'Tuesday',  type: 'quality',  label: 'Marathon Pace Run',  description: '2km warm-up + 10km at 4:45/km + 2km cool-down',               duration: '1h 10min', zone: 'Z3' },
      { day: 'Wednesday',type: 'easy',     label: 'Easy Run',           description: '10km at conversational pace (5:30–6:00/km)',                   duration: '55 min',   zone: 'Z2' },
      { day: 'Thursday', type: 'strength', label: 'Strength + Drills',  description: '30min lower body strength + 15min running drills',            duration: '45 min',   zone: null },
      { day: 'Friday',   type: 'rest',     label: 'Rest',               description: 'Complete rest. Focus on hydration and sleep.',                 duration: '—',        zone: null },
      { day: 'Saturday', type: 'quality',  label: 'Interval Session',   description: '8×800m at 4:20/km with 90s recovery jog',                     duration: '60 min',   zone: 'Z4-Z5' },
      { day: 'Sunday',   type: 'long',     label: 'Long Run',           description: '28km at easy pace (5:30–5:50/km). Build to race distance.',   duration: '2h 35min', zone: 'Z2' }
    ]
  },
  '5k': {
    goal: '5k',
    targetTime: '18:30',
    currentPrediction: '19:28',
    weekPlan: [
      { day: 'Monday',   type: 'rest',     label: 'Rest / Mobility',   description: 'Full rest or 20min mobility work',                             duration: '20 min', zone: null },
      { day: 'Tuesday',  type: 'quality',  label: 'Speed Work',        description: '10×400m at 4:00/km pace with 60s full recovery',              duration: '45 min', zone: 'Z5' },
      { day: 'Wednesday',type: 'easy',     label: 'Easy Run',          description: '6km at conversational pace (5:30–6:00/km)',                   duration: '35 min', zone: 'Z2' },
      { day: 'Thursday', type: 'strength', label: 'Strength + Drills', description: '30min lower body strength + 15min running drills',           duration: '45 min', zone: null },
      { day: 'Friday',   type: 'rest',     label: 'Rest',              description: 'Complete rest. Focus on hydration and sleep.',                duration: '—',      zone: null },
      { day: 'Saturday', type: 'quality',  label: 'Tempo Run',         description: '1km warm-up + 3km at 4:10/km + 1km cool-down',               duration: '30 min', zone: 'Z4' },
      { day: 'Sunday',   type: 'long',     label: 'Easy Long Run',     description: '12km at easy pace (5:30–6:00/km).',                          duration: '1h 10min', zone: 'Z2' }
    ]
  }
};

app.get('/api/training-week', (req, res) => {
  const goal = req.query.goal || 'half_marathon';
  const plan = TRAINING_PLANS[goal] ?? TRAINING_PLANS['half_marathon'];
  res.json(plan);
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  mcp.spawn();

  console.log('[bridge] Initialising MCP...');
  try {
    await mcp.initialize();
    console.log('[bridge] MCP initialised successfully.');
  } catch (err) {
    console.error('[bridge] MCP init error (will retry on next spawn):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`[bridge] Garmin Bridge listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[bridge] Fatal:', err);
  process.exit(1);
});
