const BRIDGE = 'http://localhost:3333';

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
