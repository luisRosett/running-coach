import { checkBridge, getHealthSummary, getLastActivity, getRecommendations } from './garmin-client.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const healthGrid = document.getElementById('healthGrid');
const kpiContainer = document.getElementById('kpis');
const recommendationsContainer = document.getElementById('recommendations');
const connectionStatus = document.getElementById('connectionStatus');
const lastSync = document.getElementById('lastSync');
const goalForm = document.getElementById('goalForm');
const goalList = document.getElementById('goalList');

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
  // 1. Check bridge connectivity
  const connected = await checkBridge().catch(() => false);
  setConnectionBadge(connected);

  // 2. Fetch all data in parallel, never crashing if individual calls fail
  const [healthResult, activityResult, recsResult] = await Promise.allSettled([
    getHealthSummary(),
    getLastActivity(),
    getRecommendations()
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

  // 3. Render
  renderHealthGrid(health);
  renderActivityKpis(activity);
  renderRecommendations(recs);

  lastSync.textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
}

boot();
