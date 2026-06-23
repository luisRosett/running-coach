'use strict';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const readline = require('readline');
const http = require('http');
const cron = require('node-cron');

// ─── Ollama ───────────────────────────────────────────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'localhost';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

function ollamaChat(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false });
    const req = http.request(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Ollama parse error: ' + data.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
  origin: ['http://localhost:5174', 'http://127.0.0.1:5174', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'null'],
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
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const [dailySummary, steps, bodyBattery, trainingReadiness, vo2max] = await Promise.allSettled([
      mcp.tool('get_daily_summary', { date: today }),
      mcp.tool('get_steps', { date: today }),
      mcp.tool('get_body_battery', { date: today }),
      mcp.tool('get_training_readiness', { date: today }),
      mcp.tool('get_vo2max', { date: yesterday })
    ]);

    const summary = dailySummary.status === 'fulfilled' ? dailySummary.value : null;
    const stepsData = steps.status === 'fulfilled' ? steps.value : null;
    const batteryData = bodyBattery.status === 'fulfilled' ? bodyBattery.value : null;
    const readinessData = trainingReadiness.status === 'fulfilled' ? trainingReadiness.value : null;
    const vo2maxData = vo2max.status === 'fulfilled' ? vo2max.value : null;
    const vo2maxVal = Array.isArray(vo2maxData) && vo2maxData.length > 0
      ? (vo2maxData[0]?.generic?.vo2MaxPreciseValue ?? vo2maxData[0]?.generic?.vo2MaxValue ?? null)
      : null;

    res.json({
      date: today,
      steps: stepsData?.totalSteps ?? stepsData?.steps ?? summary?.totalSteps ?? 0,
      restingHR: summary?.restingHeartRate ?? summary?.resting_heart_rate ?? 0,
      bodyBattery: batteryData?.bodyBatteryMostRecentValue ?? batteryData?.charged ?? batteryData?.level ?? 0,
      stressLevel: summary?.averageStressLevel ?? summary?.average_stress_level ?? 0,
      trainingReadiness: readinessData?.score ?? readinessData?.trainingReadinessScore ?? 0,
      vo2max: vo2maxVal
    });
  } catch (err) {
    console.error('[/api/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Last activity (enriched) ──────────────────────────────────────────────────
const SPORT_LABELS = {
  running: 'Running', trail_running: 'Trail Running', cycling: 'Cycling',
  lap_swimming: 'Swimming', open_water_swimming: 'Open Water', strength_training: 'Strength',
  yoga: 'Yoga', indoor_cycling: 'Indoor Cycling', elliptical: 'Elliptical',
  paddelball: 'Padel', tennis: 'Tennis', hiking: 'Hiking', walking: 'Walking',
};

function enrichActivity(a) {
  const distM = a.distance ?? 0;
  const distKm = distM / 1000;
  const durSec = a.movingDuration ?? a.duration ?? 0;
  const paceSecPerKm = distKm > 0 ? durSec / distKm : 0;

  const z1 = a.hrTimeInZone_1 ?? 0, z2 = a.hrTimeInZone_2 ?? 0,
        z3 = a.hrTimeInZone_3 ?? 0, z4 = a.hrTimeInZone_4 ?? 0,
        z5 = a.hrTimeInZone_5 ?? 0;
  const totalZ = z1 + z2 + z3 + z4 + z5;

  const aeroEffect = a.aerobicTrainingEffect ?? 0;
  const anaeEffect = a.anaerobicTrainingEffect ?? 0;

  // Training load: Garmin uses aerobicTrainingEffect (0-5) × duration proxy
  // 0-49 = low, 50-149 = medium, 150+ = high
  const loadScore = Math.round(aeroEffect * (durSec / 3600) * 20);

  return {
    activityId: a.activityId,
    name: a.activityName ?? a.name ?? 'Activity',
    sport: a.activityType?.typeKey ?? 'other',
    sportLabel: SPORT_LABELS[a.activityType?.typeKey] ?? (a.activityType?.typeKey ?? 'Activity'),
    date: (a.startTimeLocal ?? '').slice(0, 10),
    location: a.locationName ?? null,
    distanceKm: distKm > 0 ? distKm.toFixed(2) : null,
    durationMin: durSec > 0 ? Math.round(durSec / 60) : null,
    pace: paceSecPerKm > 0 ? formatSeconds(paceSecPerKm) : null,
    calories: a.calories ?? null,
    avgHR: a.averageHR ?? null,
    maxHR: a.maxHR ?? null,
    avgPower: a.avgPower ?? null,
    elevationGain: a.elevationGain ?? null,
    aerobicEffect: parseFloat(aeroEffect.toFixed(1)),
    aerobicLabel: a.trainingEffectLabel ?? null,
    anaerobicEffect: parseFloat(anaeEffect.toFixed(1)),
    loadScore,
    bodyBatteryDelta: a.differenceBodyBattery ?? null,
    hrZones: totalZ > 0 ? {
      z1: +((z1 / totalZ) * 100).toFixed(0),
      z2: +((z2 / totalZ) * 100).toFixed(0),
      z3: +((z3 / totalZ) * 100).toFixed(0),
      z4: +((z4 / totalZ) * 100).toFixed(0),
      z5: +((z5 / totalZ) * 100).toFixed(0),
    } : null,
  };
}

app.get('/api/last-activity', async (_req, res) => {
  try {
    const raw = await mcp.tool('get_activities', { limit: 20 });
    const list = Array.isArray(raw) ? raw : (raw?.activities ?? []);
    if (list.length === 0) return res.json({});
    // Return the most recent activity (whatever sport)
    res.json(enrichActivity(list[0]));
  } catch (err) {
    console.error('[/api/last-activity]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Activities list ───────────────────────────────────────────────────────────
app.get('/api/activities', async (_req, res) => {
  try {
    const data = await mcp.tool('get_activities', { limit: 20 });
    const list = Array.isArray(data) ? data : (data?.activities ?? []);
    res.json(list.map(enrichActivity));
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
    const raw5k   = data.time5K  ?? data['5k']   ?? data['5K']   ?? data.fiveK   ?? data.race5K   ?? null;
    const raw10k  = data.time10K ?? data['10k']  ?? data['10K']  ?? data.tenK    ?? data.race10K  ?? null;
    const rawHM   = data.timeHalfMarathon ?? data['halfMarathon'] ?? data['half_marathon'] ?? data.halfMarathon ?? data.raceHalfMarathon ?? null;
    const rawFull = data.timeMarathon     ?? data['marathon']     ?? data['full_marathon'] ?? data.marathon     ?? data.raceMarathon     ?? null;

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
    currentPrediction: '1:34:33',
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
    targetTime: '3:30:00',
    currentPrediction: '3:31:48',
    weekPlan: [
      { day: 'Monday',   type: 'rest',     label: 'Rest / Mobility',    description: 'Full rest or 20min mobility work',                              duration: '20 min',   zone: null },
      { day: 'Tuesday',  type: 'quality',  label: 'Marathon Pace Run',  description: '2km warm-up + 10km at 5:00/km + 2km cool-down',               duration: '1h 10min', zone: 'Z3' },
      { day: 'Wednesday',type: 'easy',     label: 'Easy Run',           description: '10km at conversational pace (6:00–6:30/km)',                   duration: '60 min',   zone: 'Z2' },
      { day: 'Thursday', type: 'strength', label: 'Strength + Drills',  description: '30min lower body strength + 15min running drills',            duration: '45 min',   zone: null },
      { day: 'Friday',   type: 'rest',     label: 'Rest',               description: 'Complete rest. Focus on hydration and sleep.',                 duration: '—',        zone: null },
      { day: 'Saturday', type: 'quality',  label: 'Interval Session',   description: '6×1km at 4:30/km with 90s recovery jog',                     duration: '55 min',   zone: 'Z4-Z5' },
      { day: 'Sunday',   type: 'long',     label: 'Long Run',           description: '30km at easy pace (6:00–6:20/km). Build to race distance.',   duration: '3h 10min', zone: 'Z2' }
    ]
  },
  hyrox: {
    goal: 'hyrox',
    targetTime: '1:04:59',
    currentPrediction: '1:20:00',
    weekPlan: [
      { day: 'Monday',    type: 'rest',     label: 'Rest / Mobility',         description: 'Complete rest + 15min hip flexor & shoulder mobility (critical for SkiErg & sled)', duration: '20 min',   zone: null },
      { day: 'Tuesday',   type: 'quality',  label: 'Run Intervals + SkiErg', description: '8×1km at 4:30/km (Hyrox running pace) with 90s rest · finish with 3×250m SkiErg',   duration: '65 min',   zone: 'Z4-Z5' },
      { day: 'Wednesday', type: 'easy',     label: 'Zone 2 Run + Pull',       description: '7km at easy pace (5:45–6:15/km) + 3 sets: 10 pull-ups, 15 ring rows, 20 KB rows',    duration: '55 min',   zone: 'Z2' },
      { day: 'Thursday',  type: 'strength', label: 'Hyrox Station Circuit',   description: '4 rounds: Sled push 20m (heavy) · Sandbag lunges 20m · Wall balls ×20 · Farmers carry 50m · 1min rest', duration: '60 min',   zone: 'Z3-Z4' },
      { day: 'Friday',    type: 'rest',     label: 'Rest',                    description: 'Full rest. Prioritise 8h sleep. Visualise station transitions.',                          duration: '—',        zone: null },
      { day: 'Saturday',  type: 'quality',  label: 'Race Simulation',         description: '4×(1km at 4:30/km + 1 Hyrox station, rotate weekly). Transition speed matters.',       duration: '70 min',   zone: 'Z3-Z5' },
      { day: 'Sunday',    type: 'long',     label: 'Long Easy Run',           description: '12km at conversational pace (5:50–6:20/km). Builds aerobic base for the 8km race runs.', duration: '1h 15min', zone: 'Z2' },
    ]
  },
  '5k': {
    goal: '5k',
    targetTime: '18:30',
    currentPrediction: '19:30',
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

function detectPlanKey(goalName) {
  const n = (goalName ?? '').toLowerCase();
  if (n.includes('hyrox'))  return 'hyrox';
  if (n.includes('half') || n.includes('21k') || n.includes('21 km') || n.includes('hm')) return 'half_marathon';
  if (n.includes('marathon') || n.includes('42k') || n.includes('42 km')) return 'marathon';
  if (n.includes('10k') || n.includes('10 km')) return '10k';
  if (n.includes('5k') || n.includes('5 km')) return '5k';
  return 'half_marathon';
}

function detectPrimaryGoal(goals) {
  if (!goals || goals.length === 0) return { planKey: 'half_marathon', goalLabel: null, targetOverride: null };
  const now = new Date();
  const sorted = [...goals].sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline) : new Date('2099-01-01');
    const db = b.deadline ? new Date(b.deadline) : new Date('2099-01-01');
    if (da < now && db >= now) return 1;
    if (db < now && da >= now) return -1;
    return da - db;
  });
  const primary = sorted[0];
  return { planKey: detectPlanKey(primary.name), goalLabel: primary.name, targetOverride: primary.target };
}

app.get('/api/training-week', (req, res) => {
  const goals = readVaultGoals();
  const explicit = req.query.goal ?? null;
  const { planKey, goalLabel, targetOverride } = explicit
    ? { planKey: explicit, goalLabel: null, targetOverride: null }
    : detectPrimaryGoal(goals);
  const base = TRAINING_PLANS[planKey] ?? TRAINING_PLANS['half_marathon'];
  res.json({ ...base, goalLabel: goalLabel ?? base.goal, targetTime: targetOverride ?? base.targetTime });
});

// ── Goals (persisted to fsbrain vault) ───────────────────────────────────────
const { execFileSync } = require('child_process');
const VAULT_GOALS = '/root/.fsbrain/vault/goals/yearly-goals.md';
const PODMAN_CONTAINER = 'bold_williams';

function readVaultFile() {
  return execFileSync('podman', ['exec', PODMAN_CONTAINER, 'cat', VAULT_GOALS], { encoding: 'utf8' });
}

function writeVaultFile(content) {
  execFileSync('podman', ['exec', '-i', PODMAN_CONTAINER, 'tee', VAULT_GOALS], { input: content });
}

function readVaultGoals() {
  try {
    const raw = readVaultFile();
    const goals = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
      if (!m || /^-+$/.test(m[1].trim()) || m[1].trim() === 'Name') continue;
      goals.push({ name: m[1].trim(), target: m[2].trim(), deadline: m[3].trim(), added: m[4].trim() });
    }
    return goals;
  } catch (e) {
    console.error('[readVaultGoals]', e.message);
    return [];
  }
}

function appendVaultGoal(goal) {
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${goal.name} | ${goal.target} | ${goal.deadline} | ${today} |`;
  const lines = readVaultFile().split('\n');
  // Insert the new row right after the header separator line |---|
  const sepIdx = lines.findIndex(l => /^\|[\s-|]+\|$/.test(l));
  if (sepIdx >= 0) {
    lines.splice(sepIdx + 1, 0, row);
  } else {
    lines.push(row);
  }
  writeVaultFile(lines.join('\n'));
}

app.get('/api/goals', (_req, res) => {
  res.json(readVaultGoals());
});

app.post('/api/goals', express.json(), (req, res) => {
  const { name, target, deadline } = req.body || {};
  if (!name || !target || !deadline) {
    return res.status(400).json({ error: 'name, target, and deadline are required' });
  }
  try {
    appendVaultGoal({ name, target, deadline });
    const goals = readVaultGoals();
    const { planKey, goalLabel, targetOverride } = detectPrimaryGoal(goals);
    const plan = TRAINING_PLANS[planKey] ?? TRAINING_PLANS['half_marathon'];
    broadcast('goals-updated', {
      goals,
      primaryGoal: { planKey, goalLabel, targetTime: targetOverride ?? plan.targetTime },
    });
    res.json({ ok: true, goals });
  } catch (err) {
    console.error('[/api/goals POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Coach Chat ─────────────────────────────────────────────────────────────
function buildAthleteContext(healthSnap, goals) {
  const goalsText = goals.length > 0
    ? goals.map(g => `- ${g.name}: target ${g.target} by ${g.deadline}`).join('\n')
    : '- No goals set yet.';

  const h = healthSnap || {};
  return `You are a personal running coach for Luis Roset, an experienced runner based in Spain.

## Athlete profile
- VO2max: ${h.vo2max ?? '55.8'} (Garmin estimate)
- Resting HR: ${h.restingHR || '—'} bpm
- Body Battery: ${h.bodyBattery || '—'}%
- Training Readiness: ${h.trainingReadiness || '—'}/100
- Stress Level: ${h.stressLevel || '—'}/100
- Steps today: ${h.steps ? h.steps.toLocaleString() : '—'}

## Current race predictions (Garmin)
- 5K: 19:30
- 10K: 40:36
- Half Marathon: 1:34:33 (PB: 1:33:54, Seville HM 2026-01-25)
- Marathon: 3:31:48

## Personal bests
- 1 km: 3:26  |  1 mile: 5:41  |  5K: 19:37  |  10K: 40:40

## Goals
${goalsText}

## Primary training focus
${(() => {
  const { planKey } = detectPrimaryGoal(goals.length > 0 ? goals : []);
  const planMap = {
    hyrox: 'Hyrox (functional fitness race: 8×1km runs + 8 workout stations). Key stations: SkiErg, Sled Push/Pull, Burpee Broad Jump, RowErg, Farmers Carry, Sandbag Lunges, Wall Balls. Doubles format means partner shares station work.',
    marathon: 'Marathon. Current prediction 3:31:48. Race pace ~5:00/km. Training emphasises long runs, marathon-pace work, and threshold intervals.',
    half_marathon: 'Half Marathon. Current prediction 1:34:33 (PB: 1:33:54). Race pace ~4:29/km.',
    '5k': '5K. Current prediction 19:30.',
    '10k': '10K. Current prediction 40:36.',
  };
  return planMap[planKey] ?? 'Running performance.';
})()}

Answer concisely and practically. When relevant, refer to the athlete's actual numbers above.`;
}

// ── Chat log → fsbrain vault ──────────────────────────────────────────────────
const VAULT_CHAT_LOGS = '/root/.fsbrain/vault/chat-logs';

function appendChatLog(userMsg, assistantReply, model) {
  try {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour12: false });
    const logPath = `${VAULT_CHAT_LOGS}/${date}.md`;

    execFileSync('podman', ['exec', PODMAN_CONTAINER, 'mkdir', '-p', VAULT_CHAT_LOGS]);

    // Check if file exists; create header if not
    let existing = '';
    try {
      existing = execFileSync('podman', ['exec', PODMAN_CONTAINER, 'cat', logPath], { encoding: 'utf8' });
    } catch {
      existing = `# Coach Chat — ${date}\n\n> Model: ${model} · All times Europe/Madrid\n`;
    }

    const entry = [
      `## ${time}`,
      '',
      `**You:** ${userMsg}`,
      '',
      `**Coach:** ${assistantReply}`,
      '',
      '---',
      '',
    ].join('\n');

    execFileSync('podman', ['exec', '-i', PODMAN_CONTAINER, 'tee', logPath],
      { input: existing + '\n' + entry });
  } catch (e) {
    console.error('[chat-log]', e.message);
  }
}

app.post('/api/chat', express.json(), async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [healthSnap, goals] = await Promise.allSettled([
      (async () => {
        const [ds, bb, tr, vo2] = await Promise.allSettled([
          mcp.tool('get_daily_summary', { date: today }),
          mcp.tool('get_body_battery', { date: today }),
          mcp.tool('get_training_readiness', { date: today }),
          mcp.tool('get_vo2max', { date: yesterday })
        ]);
        const summary = ds.status === 'fulfilled' ? ds.value : {};
        const battery = bb.status === 'fulfilled' ? bb.value : {};
        const readiness = tr.status === 'fulfilled' ? tr.value : {};
        const vo2data = vo2.status === 'fulfilled' && Array.isArray(vo2.value) ? vo2.value : [];
        return {
          restingHR: summary?.restingHeartRate ?? 0,
          bodyBattery: battery?.bodyBatteryMostRecentValue ?? battery?.charged ?? 0,
          trainingReadiness: readiness?.score ?? 0,
          stressLevel: summary?.averageStressLevel ?? 0,
          steps: summary?.totalSteps ?? 0,
          vo2max: vo2data[0]?.generic?.vo2MaxPreciseValue ?? '55.8'
        };
      })(),
      (async () => readVaultGoals())()
    ]);

    const snap = healthSnap.status === 'fulfilled' ? healthSnap.value : null;
    const goalList = goals.status === 'fulfilled' ? goals.value : [];

    const systemPrompt = buildAthleteContext(snap, goalList);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message }
    ];

    const ollamaResp = await ollamaChat(messages);
    const reply = ollamaResp?.message?.content ?? 'No response from model.';

    // Persist exchange to fsbrain vault (non-blocking)
    setImmediate(() => appendChatLog(message, reply, OLLAMA_MODEL));

    res.json({ reply, model: OLLAMA_MODEL });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE event bus ────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => r.write(payload));
}

// ─── Daily Garmin Sync ────────────────────────────────────────────────────────
const VAULT_SNAPSHOTS = '/root/.fsbrain/vault/daily-snapshots';
const VAULT_ATHLETE   = '/root/.fsbrain/vault/profile/athlete.md';

function fmtSeconds(s) {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function computeRecoveryScore({ avgStress, bodyBattery, readiness, rhr, sleepSec }) {
  let score = 5;
  if (readiness  != null) score += Math.max(-2, Math.min(2, (readiness  - 50) / 25));
  if (bodyBattery!= null) score += Math.max(-2, Math.min(2, (bodyBattery - 50) / 25));
  if (avgStress  != null) score += Math.max(-2, Math.min(2, (30 - avgStress) / 15));
  if (rhr        != null) score += Math.max(-1, Math.min(1, (55 - rhr) / 10));
  if (sleepSec   != null && sleepSec > 0) {
    const h = sleepSec / 3600;
    score += h < 5 ? -2 : h < 6 ? -1 : h < 7 ? -0.5 : h <= 9 ? 1 : 0;
  }
  return Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
}

function recoveryLabel(score) {
  if (score >= 8)   return { label: 'Excellent', advice: 'Top condition — go for a quality session or race simulation.' };
  if (score >= 6.5) return { label: 'Good',      advice: 'Good recovery. Moderate intensity session or tempo run recommended.' };
  if (score >= 5)   return { label: 'Fair',       advice: 'Adequate recovery. Keep intensity low — easy run or cross-training.' };
  if (score >= 3)   return { label: 'Poor',       advice: 'Recovery is below average. Rest or light mobility work today.' };
  return                   { label: 'Very poor',  advice: 'Your body needs rest. Skip training and focus on sleep and nutrition.' };
}

function saveSnapshotToVault(date, snap) {
  const { sleepSec, deepSec, remSec, avgStress, maxStress, rhr, bodyBattery,
          readiness, vo2max, steps, recoveryScore, recoveryInfo } = snap;

  execFileSync('podman', ['exec', PODMAN_CONTAINER, 'mkdir', '-p', VAULT_SNAPSHOTS]);

  const md = [
    `# Daily Health Snapshot — ${date}`,
    '',
    `> Synced automatically by Garmin Bridge at ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })} (Madrid)`,
    '',
    '## Recovery',
    `| Metric | Value |`,
    `|---|---|`,
    `| Recovery score | **${recoveryScore}/10** — ${recoveryInfo.label} |`,
    rhr         != null ? `| Resting HR | ${rhr} bpm |`       : '',
    bodyBattery != null ? `| Body Battery | ${bodyBattery}% |` : '',
    readiness   != null ? `| Training Readiness | ${readiness}/100 |` : '',
    avgStress   != null ? `| Avg Stress (overnight) | ${avgStress} |` : '',
    maxStress   != null ? `| Max Stress | ${maxStress} |`     : '',
    vo2max      != null ? `| VO2max | ${vo2max} |`            : '',
    '',
    '## Sleep',
    sleepSec && sleepSec > 0 ? [
      `| Metric | Value |`,
      `|---|---|`,
      `| Total sleep | ${fmtSeconds(sleepSec)} |`,
      deepSec ? `| Deep sleep | ${fmtSeconds(deepSec)} |` : '',
      remSec  ? `| REM sleep  | ${fmtSeconds(remSec)} |`  : '',
    ].filter(Boolean).join('\n') : '_Sleep data not available for this night._',
    '',
    '## Activity',
    steps > 0 ? `- Steps today: ${steps.toLocaleString()}` : '_No step data yet._',
    '',
    `## Coach note`,
    `> ${recoveryInfo.advice}`,
    '',
    '## Tags',
    '#daily #health #recovery',
  ].filter(l => l !== null).join('\n');

  execFileSync('podman', ['exec', '-i', PODMAN_CONTAINER, 'tee',
    `${VAULT_SNAPSHOTS}/${date}.md`], { input: md });
}

async function syncGarminData(triggeredBy = 'cron') {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);

  console.log(`[sync] Starting daily sync (${triggeredBy}) for ${today}…`);

  const [sleepR, stressR, rhrR, batteryR, readinessR, vo2R, summaryR, stepsR] =
    await Promise.allSettled([
      mcp.tool('get_sleep_data',         { date: today }),
      mcp.tool('get_stress',             { date: today }),
      mcp.tool('get_resting_heart_rate', { date: today }),
      mcp.tool('get_body_battery',       { date: today }),
      mcp.tool('get_training_readiness', { date: today }),
      mcp.tool('get_vo2max',             { date: yesterday }),
      mcp.tool('get_daily_summary',      { date: today }),
      mcp.tool('get_steps',              { date: today }),
    ]);

  // ── Parse ────────────────────────────────────────────────────────────────────
  const sleepRaw = sleepR.status === 'fulfilled' ? sleepR.value : null;
  const sleepDto = sleepRaw?.dailySleepDTO ?? sleepRaw ?? {};
  const sleepSec  = sleepDto.sleepTimeSeconds  ?? null;
  const deepSec   = sleepDto.deepSleepSeconds  ?? null;
  const remSec    = sleepDto.remSleepSeconds   ?? null;

  const stressData  = stressR.status === 'fulfilled' ? stressR.value : {};
  const avgStress   = stressData?.avgStressLevel  ?? null;
  const maxStress   = stressData?.maxStressLevel  ?? null;

  const rhrRaw = rhrR.status === 'fulfilled' ? rhrR.value : null;
  const rhr = rhrRaw?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE?.[0]?.value ?? null;

  const battData    = batteryR.status === 'fulfilled' ? batteryR.value : {};
  const bodyBattery = battData?.bodyBatteryMostRecentValue ?? battData?.charged ?? battData?.level ?? null;

  const readData    = readinessR.status === 'fulfilled' ? readinessR.value : {};
  const readiness   = readData?.score ?? readData?.trainingReadinessScore ?? null;

  const vo2Arr  = vo2R.status === 'fulfilled' && Array.isArray(vo2R.value) ? vo2R.value : [];
  const vo2max  = vo2Arr[0]?.generic?.vo2MaxPreciseValue ?? vo2Arr[0]?.generic?.vo2MaxValue ?? null;

  const summary = summaryR.status === 'fulfilled' ? summaryR.value : {};
  const stepsData = stepsR.status === 'fulfilled' ? stepsR.value : {};
  const steps   = stepsData?.totalSteps ?? stepsData?.steps ?? summary?.totalSteps ?? 0;

  // ── Recovery score ───────────────────────────────────────────────────────────
  const recoveryScore = computeRecoveryScore({ avgStress, bodyBattery, readiness, rhr, sleepSec });
  const recoveryInfo  = recoveryLabel(recoveryScore);

  const snap = { sleepSec, deepSec, remSec, avgStress, maxStress, rhr, bodyBattery,
                 readiness, vo2max, steps, recoveryScore, recoveryInfo };

  // ── Persist to fsbrain vault ─────────────────────────────────────────────────
  try {
    saveSnapshotToVault(today, snap);
    console.log(`[sync] Snapshot saved to vault for ${today}`);
  } catch (e) {
    console.error('[sync] Vault write failed:', e.message);
  }

  // ── Broadcast SSE to all open UI tabs ───────────────────────────────────────
  broadcast('garmin-sync', {
    date: today,
    recoveryScore,
    recoveryLabel: recoveryInfo.label,
    recoveryAdvice: recoveryInfo.advice,
    rhr, bodyBattery, readiness, avgStress, vo2max, steps,
    sleepFormatted: fmtSeconds(sleepSec),
  });

  console.log(`[sync] Done. Recovery ${recoveryScore}/10 — ${recoveryInfo.label}`);
  return snap;
}

// Manual trigger
app.post('/api/sync', async (_req, res) => {
  try {
    const snap = await syncGarminData('manual');
    res.json({ ok: true, ...snap });
  } catch (err) {
    console.error('[/api/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Last sync status
let lastSyncSnap = null;
app.get('/api/sync/status', (_req, res) => {
  res.json(lastSyncSnap ?? { synced: false });
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

  // Initial sync on startup (non-blocking)
  setTimeout(async () => {
    try {
      lastSyncSnap = await syncGarminData('startup');
    } catch (e) {
      console.error('[sync] Startup sync failed:', e.message);
    }
  }, 3000);

  // Daily cron: 10:00 AM Europe/Madrid (CET/CEST aware)
  cron.schedule('0 10 * * *', async () => {
    try {
      lastSyncSnap = await syncGarminData('cron');
    } catch (e) {
      console.error('[sync] Cron sync failed:', e.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[bridge] Daily sync scheduled: 10:00 AM Europe/Madrid');
}

main().catch((err) => {
  console.error('[bridge] Fatal:', err);
  process.exit(1);
});
