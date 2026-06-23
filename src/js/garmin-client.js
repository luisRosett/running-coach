const BRIDGE = localStorage.getItem('bridgeUrl') || 'http://localhost:3333';

export async function getHealthSummary() {
  const r = await fetch(`${BRIDGE}/api/summary`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function getLastActivity() {
  const r = await fetch(`${BRIDGE}/api/last-activity`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function getRecommendations() {
  const r = await fetch(`${BRIDGE}/api/recommendations`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function checkBridge() {
  try {
    const r = await fetch(`${BRIDGE}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function getRacePredictions() {
  const r = await fetch(`${BRIDGE}/api/race-predictions`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function getPersonalRecords() {
  const r = await fetch(`${BRIDGE}/api/personal-records`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function getTrainingWeek(goal) {
  const url = goal ? `${BRIDGE}/api/training-week?goal=${goal}` : `${BRIDGE}/api/training-week`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function sendChatMessage(message, history = []) {
  const r = await fetch(`${BRIDGE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history })
  });
  if (!r.ok) throw new Error('Chat error');
  return r.json();
}

export async function getGoals() {
  const r = await fetch(`${BRIDGE}/api/goals`);
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export async function saveGoal(goal) {
  const r = await fetch(`${BRIDGE}/api/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(goal)
  });
  if (!r.ok) throw new Error('Bridge error');
  return r.json();
}

export function getBridgeUrl() {
  return localStorage.getItem('bridgeUrl') || 'http://localhost:3333';
}

export function setBridgeUrl(url) {
  localStorage.setItem('bridgeUrl', url);
}
