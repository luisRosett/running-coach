const CONFIG_PATH = "./config/strava-mcp.config.json";
const DEFAULT_BRIDGE_BASE_URL = "http://localhost:3333/strava";

const ENDPOINTS = {
  summary: "/api/strava/summary",
  activities: "/api/strava/activities",
  recommendations: "/api/strava/recommendations"
};

async function loadMcpConfig() {
  try {
    const response = await fetch(CONFIG_PATH);
    if (!response.ok) throw new Error("Config file not found");
    return response.json();
  } catch {
    return null;
  }
}

export async function getDashboardData() {
  const config = await loadMcpConfig();
  const bridgeBaseUrl = config?.localBridge?.endpoint || DEFAULT_BRIDGE_BASE_URL;

  try {
    const requestWithBridge = async (path) => {
      const response = await fetch(`${bridgeBaseUrl}${path}`);
      if (!response.ok) throw new Error(`Bridge error: ${response.status}`);
      return response.json();
    };

    const [summary, recommendations] = await Promise.all([
      requestWithBridge(ENDPOINTS.summary),
      requestWithBridge(ENDPOINTS.recommendations)
    ]);

    return {
      isBridgeConnected: true,
      configLoaded: Boolean(config),
      summary,
      recommendations
    };
  } catch {
    // Fallback lets the UI render even before bridge wiring is implemented.
    return {
      isBridgeConnected: false,
      configLoaded: Boolean(config),
      summary: {
        weeklyDistanceKm: 0,
        weeklyMovingTimeHours: 0,
        weeklyElevationM: 0,
        currentCTL: 0
      },
      recommendations: [
        "Connect your local MCP bridge endpoint to load recommendations.",
        "Add your first activity sync and refresh this dashboard."
      ]
    };
  }
}
