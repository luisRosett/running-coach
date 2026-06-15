# Strava Web App Skeleton

## High-level Flow

```mermaid
flowchart LR
    A[Browser App] --> B[Local API Bridge]
    B --> C[Strava MCP Server]
    C --> D[Strava Data]
    D --> B
    B --> A
```

## Initial Dashboard Blocks

```mermaid
flowchart TD
    D[Dashboard] --> K[Weekly KPI Cards]
    D --> T[Trend Chart Placeholders]
    D --> R[Training Recommendations]
    D --> G[Yearly Goals Section]
```

## Data Lifecycle (Skeleton)

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web App
    participant B as Local Bridge
    participant M as Strava MCP

    U->>W: Open app / click refresh
    W->>W: Load config file
    W->>B: Request summarized metrics
    B->>M: MCP query tools
    M-->>B: Activities and stats
    B-->>W: Dashboard payload
    W-->>U: Render KPIs and recommendations
```

## Notes

- Keep browser credentials out of client-side code.
- Use a local bridge/service to call MCP tools securely.
- The current app is a skeleton with placeholders for values.
