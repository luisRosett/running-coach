import {
  checkBridge,
  getHealthSummary,
  getLastActivity,
  getRecommendations,
  getRacePredictions,
  getPersonalRecords,
  getTrainingWeek,
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
    ['Training Readiness', summary.trainingReadiness ? `${summary.trainingReadiness}` : '—']
  ];
  healthGrid.innerHTML = entries.map(([label, value]) => kpiCard(label, value)).join('');
}

function renderActivityKpis(activity) {
  if (!activity || Object.keys(activity).length === 0) {
    kpiContainer.innerHTML = kpiCard('Status', 'No activity data');
    return;
  }

  const name = activity.activityName ?? activity.name ?? 'Activity';
  const type = activity.activityType?.typeKey ?? activity.sport ?? activity.activityTypeName ?? '—';
  const durationSec = activity.duration ?? activity.movingDuration ?? activity.elapsedDuration ?? 0;
  const durationMin = durationSec > 0 ? Math.round(durationSec / 60) : 0;
  const calories = activity.calories ?? activity.activeKilocalories ?? 0;
  const avgHR = activity.averageHR ?? activity.avgHr ?? 0;

  const entries = [
    ['Activity', safeVal(name)],
    ['Type', safeVal(type)],
    ['Duration', durationMin ? `${durationMin} min` : '—'],
    ['Calories', calories ? `${calories} kcal` : '—'],
    ['Avg HR', avgHR ? `${avgHR} bpm` : '—']
  ];

  kpiContainer.innerHTML = entries.map(([label, value]) => kpiCard(label, value)).join('');
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

  trainingGoalLine.textContent = `Target: ${plan.targetTime} · Current prediction: ${plan.currentPrediction}`;

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
function renderGoal(goal) {
  const li = document.createElement('li');
  li.textContent = `${goal.name} — ${goal.target} (by ${goal.deadline})`;
  goalList.appendChild(li);
}

goalForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const goal = {
    name: document.getElementById('goalName').value.trim(),
    target: document.getElementById('goalTarget').value.trim(),
    deadline: document.getElementById('goalDeadline').value
  };

  if (!goal.name || !goal.target || !goal.deadline) return;

  renderGoal(goal);
  goalForm.reset();
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
  const [healthResult, activityResult, recsResult, predsResult, pbsResult, weekResult] =
    await Promise.allSettled([
      getHealthSummary(),
      getLastActivity(),
      getRecommendations(),
      getRacePredictions(),
      getPersonalRecords(),
      getTrainingWeek('half_marathon')
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

  // 3. Render
  renderHealthGrid(health);
  renderActivityKpis(activity);
  renderRecommendations(recs);
  renderRacingProfile(pbs, predictions);
  if (weekPlan) renderTrainingWeek(weekPlan);

  lastSync.textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
}

boot();
