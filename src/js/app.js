import {
  checkBridge,
  getHealthSummary,
  getLastActivity,
  getRecommendations,
  getRacePredictions,
  getPersonalRecords,
  getTrainingWeek,
  getGoals,
  saveGoal,
  sendChatMessage,
  getBridgeUrl,
  setBridgeUrl
} from './garmin-client.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const healthGrid = document.getElementById('healthGrid');
const kpiContainer = document.getElementById('kpis');
const recommendationsContainer = document.getElementById('recommendations');
const connectionStatus = document.getElementById('connectionStatus');
const lastSync = document.getElementById('lastSync');
const goalForm = document.getElementById('goalForm');
const goalList = document.getElementById('goalList');
const pbGrid = document.getElementById('pbGrid');
const weekGrid = document.getElementById('weekGrid');
const trainingGoalLine = document.getElementById('trainingGoalLine');
const bridgeSettingsBtn = document.getElementById('bridgeSettingsBtn');
const settingsModal = document.getElementById('settingsModal');
const bridgeUrlInput = document.getElementById('bridgeUrlInput');
const saveBridgeBtn = document.getElementById('saveBridgeBtn');
const cancelBridgeBtn = document.getElementById('cancelBridgeBtn');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function kpiCard(label, value) {
  return `
    <article class="kpi">
      <p class="kpi-label">${label}</p>
      <p class="kpi-value">${value}</p>
    </article>
  `;
}

function safeVal(v, fallback = '—') {
  return (v !== null && v !== undefined && v !== 0 && v !== '') ? v : fallback;
}

// ─── Renderers ────────────────────────────────────────────────────────────────
function renderHealthGrid(summary) {
  const entries = [
    ['Steps', summary.steps ? summary.steps.toLocaleString() : '—'],
    ['Resting HR', summary.restingHR ? `${summary.restingHR} bpm` : '—'],
    ['Body Battery', summary.bodyBattery ? `${summary.bodyBattery}%` : '—'],
    ['Stress Level', summary.stressLevel ? `${summary.stressLevel}` : '—'],
    ['Training Readiness', summary.trainingReadiness ? `${summary.trainingReadiness}` : '—'],
    ['VO2max', summary.vo2max ? `${summary.vo2max}` : '55.8']
  ];
  healthGrid.innerHTML = entries.map(([label, value]) => kpiCard(label, value)).join('');
}

const SPORT_ICONS = {
  running: '🏃', trail_running: '⛰️', cycling: '🚴', lap_swimming: '🏊',
  open_water_swimming: '🌊', strength_training: '🏋️', yoga: '🧘',
  paddelball: '🎾', tennis: '🎾', hiking: '🥾', walking: '🚶',
  indoor_cycling: '🚴', elliptical: '⚡',
};

function loadBar(pct, color) {
  return `<div class="load-bar-wrap"><div class="load-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

function renderLastActivity(a) {
  if (!a || !a.name) {
    kpiContainer.innerHTML = `<p style="color:var(--ink-soft);font-size:.88rem">No recent activity data.</p>`;
    return;
  }

  const icon = SPORT_ICONS[a.sport] ?? '⚡';
  const hrZones = a.hrZones;

  kpiContainer.innerHTML = `
    <div class="activity-header">
      <span class="activity-icon">${icon}</span>
      <div>
        <p class="activity-name">${a.name}</p>
        <p class="activity-meta">${a.date ?? ''}${a.location ? ' · ' + a.location : ''} · ${a.sportLabel}</p>
      </div>
    </div>

    <div class="activity-stats">
      ${a.distanceKm  ? `<div class="astat"><p class="astat-v">${a.distanceKm} km</p><p class="astat-l">Distance</p></div>` : ''}
      ${a.pace        ? `<div class="astat"><p class="astat-v">${a.pace}/km</p><p class="astat-l">Pace</p></div>` : ''}
      ${a.durationMin ? `<div class="astat"><p class="astat-v">${a.durationMin} min</p><p class="astat-l">Duration</p></div>` : ''}
      ${a.avgHR       ? `<div class="astat"><p class="astat-v">${a.avgHR} bpm</p><p class="astat-l">Avg HR</p></div>` : ''}
      ${a.calories    ? `<div class="astat"><p class="astat-v">${a.calories}</p><p class="astat-l">kcal</p></div>` : ''}
      ${a.elevationGain ? `<div class="astat"><p class="astat-v">+${a.elevationGain} m</p><p class="astat-l">Elevation</p></div>` : ''}
      ${a.avgPower    ? `<div class="astat"><p class="astat-v">${a.avgPower} W</p><p class="astat-l">Avg Power</p></div>` : ''}
    </div>

    <div class="activity-load">
      <div class="load-row">
        <span class="load-label">Aerobic effect</span>
        <span class="load-val">${a.aerobicEffect ?? '—'}/5${a.aerobicLabel ? ' · ' + a.aerobicLabel.replace(/_\d+$/, '').toLowerCase().replace(/_/g, ' ') : ''}</span>
      </div>
      ${loadBar(Math.min((a.aerobicEffect ?? 0) / 5 * 100, 100), 'var(--accent)')}

      <div class="load-row" style="margin-top:.5rem">
        <span class="load-label">Anaerobic effect</span>
        <span class="load-val">${a.anaerobicEffect ?? '—'}/5</span>
      </div>
      ${loadBar(Math.min((a.anaerobicEffect ?? 0) / 5 * 100, 100), 'var(--accent-2)')}

      ${a.bodyBatteryDelta !== null && a.bodyBatteryDelta !== undefined ? `
      <div class="load-row" style="margin-top:.5rem">
        <span class="load-label">Body battery impact</span>
        <span class="load-val" style="color:var(--accent-2)">${a.bodyBatteryDelta} pts</span>
      </div>` : ''}
    </div>

    ${hrZones ? `
    <div class="hr-zones">
      <p class="load-label" style="margin-bottom:.35rem">HR Zones</p>
      <div class="zone-bars">
        ${['z1','z2','z3','z4','z5'].map((z,i) => `
          <div class="zone-col">
            <div class="zone-fill" style="height:${hrZones[z] ?? 0}%;opacity:${0.4 + i*0.15}"></div>
            <span class="zone-pct">${hrZones[z] ?? 0}%</span>
            <span class="zone-lbl">Z${i+1}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}
  `;
}

function renderRecommendations(items) {
  if (!Array.isArray(items) || items.length === 0) {
    recommendationsContainer.innerHTML = '<li>No recommendations available right now.</li>';
    return;
  }
  recommendationsContainer.innerHTML = items.map((item) => `<li>${item}</li>`).join('');
}

function setConnectionBadge(connected) {
  connectionStatus.textContent = connected ? 'Garmin connected' : 'Bridge not connected';
  connectionStatus.style.borderColor = connected ? '#1f8f68' : '#ef7d57';
  connectionStatus.style.color = connected ? '#1f8f68' : '#ef7d57';
}

// ─── Racing Profile renderer ───────────────────────────────────────────────────
function renderRacingProfile(pbs, predictions) {
  const distances = [
    { key: '1km',  label: '1 km',   pbKey: 'fastest1k',            predKey: null },
    { key: '1mi',  label: '1 Mile', pbKey: 'fastest1mi',           predKey: null },
    { key: '5k',   label: '5K',     pbKey: 'fastest5k',            predKey: '5k' },
    { key: '10k',  label: '10K',    pbKey: 'fastest10k',           predKey: '10k' },
    { key: 'hm',   label: 'HM',     pbKey: 'fastestHalfMarathon',  predKey: 'halfMarathon' },
    { key: 'mar',  label: 'Marathon', pbKey: null,                 predKey: 'marathon' }
  ];

  const cards = distances.map(({ label, pbKey, predKey }) => {
    const pb = pbKey ? pbs[pbKey] : null;
    const pred = predKey ? predictions[predKey] : null;

    const pbFormatted   = pb   ? pb.formatted   : '—';
    const predFormatted = pred ? pred.formatted  : '—';

    // "On track to PB" if prediction is strictly faster than recorded PB
    let note = '';
    if (pb && pred && pred.seconds < pb.seconds) {
      note = `<p class="pb-note">&#8593; On track to PB</p>`;
    }

    return `
      <article class="pb-card">
        <p class="pb-distance">${label}</p>
        <div class="pb-row">
          <span class="pb-label">PB</span><span class="pb-val mono">${pbFormatted}</span>
        </div>
        <div class="pb-row">
          <span class="pb-label">Predicted</span><span class="pb-val mono accent">${predFormatted}</span>
        </div>
        ${note}
      </article>
    `;
  });

  pbGrid.innerHTML = cards.join('');
}

// ─── Training Week renderer ───────────────────────────────────────────────────
function renderTrainingWeek(plan) {
  if (!plan || !Array.isArray(plan.weekPlan)) return;

  const goalDesc = plan.goalLabel && plan.goalLabel !== plan.goal ? plan.goalLabel : plan.goal.replace('_', ' ');
  trainingGoalLine.textContent = `Goal: ${goalDesc} · Target: ${plan.targetTime} · Current prediction: ${plan.currentPrediction}`;

  const cards = plan.weekPlan.map(({ day, type, label, description, duration, zone }) => {
    const zoneText = zone || '—';
    return `
      <article class="day-card day-${type}">
        <p class="day-name">${day}</p>
        <p class="day-label">${label}</p>
        <p class="day-desc">${description}</p>
        <div class="day-meta">
          <span class="day-duration">${duration}</span>
          <span class="day-zone">${zoneText}</span>
        </div>
      </article>
    `;
  });

  weekGrid.innerHTML = cards.join('');
}

// ─── AI Coach Chat ────────────────────────────────────────────────────────────
const syncBtn       = document.getElementById('syncBtn');
const recoveryBadge = document.getElementById('recoveryBadge');

// ─── SSE: live updates from the bridge ───────────────────────────────────────
function connectSSE() {
  const BRIDGE = getBridgeUrl();
  const es = new EventSource(`${BRIDGE}/api/events`);

  es.addEventListener('garmin-sync', (e) => {
    const snap = JSON.parse(e.data);
    showRecoveryBadge(snap.recoveryScore, snap.recoveryLabel);
    lastSync.textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
    refreshAllSections();
  });

  es.addEventListener('goals-updated', () => {
    // Re-fetch training week (plan may have changed due to new goal)
    Promise.allSettled([getTrainingWeek(), getGoals()]).then(([weekR, goalsR]) => {
      if (weekR.status === 'fulfilled') renderTrainingWeek(weekR.value);
      if (goalsR.status === 'fulfilled') renderGoals(goalsR.value);
    });
  });

  es.onerror = () => {
    // Reconnect after 10s if connection drops
    es.close();
    setTimeout(connectSSE, 10000);
  };
}

function showRecoveryBadge(score, label) {
  if (!score && score !== 0) return;
  recoveryBadge.textContent = `Recovery ${score}/10 · ${label}`;
  recoveryBadge.classList.remove('hidden', 'recovery-excellent', 'recovery-good', 'recovery-fair', 'recovery-poor');
  if (score >= 8)   recoveryBadge.classList.add('recovery-excellent');
  else if (score >= 6.5) recoveryBadge.classList.add('recovery-good');
  else if (score >= 5)   recoveryBadge.classList.add('recovery-fair');
  else                   recoveryBadge.classList.add('recovery-poor');
  recoveryBadge.classList.remove('hidden');
}

async function refreshAllSections() {
  const [healthResult, activityResult, recsResult, predsResult, pbsResult, weekResult] =
    await Promise.allSettled([
      getHealthSummary(), getLastActivity(), getRecommendations(),
      getRacePredictions(), getPersonalRecords(), getTrainingWeek()
    ]);
  const health = healthResult.status === 'fulfilled' ? healthResult.value
    : { steps: 0, restingHR: 0, bodyBattery: 0, stressLevel: 0, trainingReadiness: 0 };
  renderHealthGrid(health);
  if (activityResult.status === 'fulfilled') renderLastActivity(activityResult.value);
  if (recsResult.status === 'fulfilled' && Array.isArray(recsResult.value)) renderRecommendations(recsResult.value);
  if (predsResult.status === 'fulfilled' && pbsResult.status === 'fulfilled')
    renderRacingProfile(pbsResult.value, predsResult.value);
  if (weekResult.status === 'fulfilled') renderTrainingWeek(weekResult.value);
}

// Manual sync button
syncBtn.addEventListener('click', async () => {
  syncBtn.textContent = '↻ Syncing…';
  syncBtn.disabled = true;
  try {
    await fetch(`${getBridgeUrl()}/api/sync`, { method: 'POST' });
    // SSE will fire and call refreshAllSections() automatically
  } catch {
    syncBtn.textContent = '↻ Sync';
    syncBtn.disabled = false;
  }
  setTimeout(() => { syncBtn.textContent = '↻ Sync'; syncBtn.disabled = false; }, 8000);
});

const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

let chatHistory = [];

function appendChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-bubble chat-${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = '';
  chatSendBtn.disabled = true;
  appendChatBubble('user', message);

  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble chat-assistant chat-thinking';
  thinking.textContent = '…';
  chatMessages.appendChild(thinking);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const { reply } = await sendChatMessage(message, chatHistory);
    chatMessages.removeChild(thinking);
    appendChatBubble('assistant', reply);
    chatHistory.push({ role: 'user', content: message });
    chatHistory.push({ role: 'assistant', content: reply });
    if (chatHistory.length > 16) chatHistory = chatHistory.slice(-16);
  } catch {
    chatMessages.removeChild(thinking);
    appendChatBubble('assistant', 'Coach is unavailable right now — make sure the bridge and Ollama are running.');
  } finally {
    chatSendBtn.disabled = false;
    chatInput.focus();
  }
});

// ─── Bridge settings modal ────────────────────────────────────────────────────
bridgeSettingsBtn.addEventListener('click', () => {
  bridgeUrlInput.value = getBridgeUrl();
  settingsModal.classList.remove('hidden');
});

saveBridgeBtn.addEventListener('click', () => {
  const url = bridgeUrlInput.value.trim();
  if (url) {
    setBridgeUrl(url);
    window.location.reload();
  }
});

cancelBridgeBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hidden');
  }
});

// ─── Goal form ────────────────────────────────────────────────────────────────
function renderGoals(goals) {
  goalList.innerHTML = goals.length === 0
    ? '<li class="empty-goals">No goals yet — add one above.</li>'
    : goals.map(g => `
        <li class="goal-item">
          <span class="goal-name">${g.name}</span>
          <span class="goal-sep">·</span>
          <span class="goal-target mono">${g.target}</span>
          <span class="goal-sep">·</span>
          <span class="goal-deadline">by ${g.deadline}</span>
        </li>`).join('');
}

goalForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const goal = {
    name: document.getElementById('goalName').value.trim(),
    target: document.getElementById('goalTarget').value.trim(),
    deadline: document.getElementById('goalDeadline').value
  };

  if (!goal.name || !goal.target || !goal.deadline) return;

  const submitBtn = goalForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    const result = await saveGoal(goal);
    renderGoals(result.goals ?? []);
    goalForm.reset();
  } catch {
    alert('Could not save goal — check the bridge is running.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Add Goal';
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // 0. Load app config to get bridge URL fallback (if not already in localStorage)
  if (!localStorage.getItem('bridgeUrl')) {
    try {
      const cfg = await fetch('./config/app.config.json').then((r) => r.json());
      if (cfg.bridgeUrl && cfg.bridgeUrl !== 'http://localhost:3333') {
        // Only apply non-default values from config so localhost default still works
        localStorage.setItem('bridgeUrl', cfg.bridgeUrl);
      }
    } catch {
      // config not available — harmless, BRIDGE constant already has the default
    }
  }

  // 1. Check bridge connectivity
  const connected = await checkBridge().catch(() => false);
  setConnectionBadge(connected);

  // 2. Fetch all data in parallel, never crashing if individual calls fail
  const [healthResult, activityResult, recsResult, predsResult, pbsResult, weekResult, goalsResult] =
    await Promise.allSettled([
      getHealthSummary(),
      getLastActivity(),
      getRecommendations(),
      getRacePredictions(),
      getPersonalRecords(),
      getTrainingWeek(),
      getGoals()
    ]);

  const health = healthResult.status === 'fulfilled'
    ? healthResult.value
    : { steps: 0, restingHR: 0, bodyBattery: 0, stressLevel: 0, trainingReadiness: 0 };

  const activity = activityResult.status === 'fulfilled'
    ? activityResult.value
    : {};

  const recs = recsResult.status === 'fulfilled' && Array.isArray(recsResult.value)
    ? recsResult.value
    : ['Start the Garmin bridge to load personalised recommendations.'];

  const predictions = predsResult.status === 'fulfilled' ? predsResult.value : {};
  const pbs         = pbsResult.status   === 'fulfilled' ? pbsResult.value   : {};
  const weekPlan    = weekResult.status  === 'fulfilled' ? weekResult.value   : null;
  const goals       = goalsResult.status === 'fulfilled' ? goalsResult.value  : [];

  // 3. Render
  renderHealthGrid(health);
  renderLastActivity(activity);
  renderRecommendations(recs);
  renderRacingProfile(pbs, predictions);
  if (weekPlan) renderTrainingWeek(weekPlan);
  renderGoals(goals);

  lastSync.textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
}

boot();
connectSSE();
