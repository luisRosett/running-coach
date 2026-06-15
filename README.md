# Running Coach — AI Personal Trainer

A personal training dashboard powered by **Garmin Connect** data via the Garmin Connect MCP. The app shows today's health snapshot (steps, body battery, HRV-based stress, training readiness), your last activity, and AI-driven training recommendations — all sourced live from your Garmin account.

## How it works

```
Garmin Connect MCP (stdio)
        |
        v
  garmin-bridge.js  (Express, port 3333)
        |
        v
   index.html + app.js  (static, port 5173)
```

The bridge spawns the Garmin MCP as a child process, communicates with it over JSON-RPC 2.0 (stdin/stdout), and exposes a small REST API that the front-end fetches.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in your Garmin Connect credentials:

```
GARMIN_EMAIL=your@email.com
GARMIN_PASSWORD=<your-garmin-password>
BRIDGE_PORT=3333
```

> Your credentials are only used locally to authenticate the Garmin MCP process. They are never committed to version control (`.env` is in `.gitignore`).

### 3. Run

**Two separate terminals:**

```bash
# Terminal 1 — start the bridge
npm run bridge

# Terminal 2 — serve the front-end
npm run serve
```

**Or, all-in-one with concurrently:**

```bash
npm run dev
```

Then open http://localhost:5173 in your browser.

## Project structure

```
.
├── .env.example                  # Credentials template (copy to .env)
├── .gitignore
├── package.json
├── index.html                    # Dashboard UI
├── README.md
├── config
│   ├── garmin-mcp.config.json    # Garmin MCP metadata & tool catalogue
│   └── strava-mcp.config.json    # Strava MCP config (future use)
├── docs
│   └── architecture-and-dashboards.md
├── server
│   └── garmin-bridge.js          # Express bridge — spawns MCP, exposes REST API
└── src
    ├── js
    │   ├── app.js                # Dashboard logic & rendering
    │   └── garmin-client.js      # Fetch helpers for the bridge API
    └── styles
        └── main.css
```

## Bridge API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Bridge liveness check |
| `GET /api/summary` | Today's steps, resting HR, body battery, stress, training readiness |
| `GET /api/last-activity` | Most recent Garmin activity |
| `GET /api/activities` | Last 10 activities |
| `GET /api/recommendations` | Rule-based training recommendations from readiness / HRV / body battery |

## GitHub Pages

The static frontend (`index.html`, `src/`, `config/`) is automatically deployed to GitHub Pages on every push to `main` via the `.github/workflows/pages.yml` workflow.

Because the bridge server runs on your local machine, the deployed page will show "Bridge not connected" by default. To connect it:

1. Start your local bridge: `npm run bridge`
2. Open the deployed app in your browser
3. Click the **⚙ Bridge** button in the header
4. Enter the URL where your bridge is reachable (e.g. `http://192.168.1.x:3333` if on the same Wi-Fi, or a tunnel URL such as one created with `ngrok http 3333`)
5. Click **Save & Reload** — the setting is stored in `localStorage` and persists across sessions

> The server directory, `.env`, and `node_modules` are never included in the Pages deployment.

## Notes

- The MCP process is restarted automatically if it crashes.
- All bridge calls have a 20-second timeout; the UI falls back gracefully to zeros / empty states if the bridge is unavailable.
- **Strava MCP support** is planned once Strava MCP rollout access is granted. The `config/strava-mcp.config.json` file is kept as a reference for that integration.
