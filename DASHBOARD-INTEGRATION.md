# LEADER Dashboard API Integration

## What changed
- Added `GET /api/anti-spam` and `PUT /api/anti-spam` to the existing HTTP health server.
- Requests require `Authorization: Bearer <DASHBOARD_API_KEY>`.
- Configuration is validated and saved in `dashboard-antispam.json` (local filesystem). On hosts with ephemeral filesystems, use a persistent disk or move this JSON to Supabase before relying on it across deploys.
- `processAntiSpam` now reads the configured threshold/window/action, supports optional deletion and timeout, and can ignore moderators/admins and configured role names.
- Included `LEADER-dashboard-v4-connected.html`, with URL/key fields and Load/Save buttons.
- Added `DASHBOARD_API_KEY` to `render.yaml` so Render prompts you to configure the required dashboard API secret during setup. The key must match the value entered in the dashboard.

## Render environment
In Render, open the `leader-bot` web service → **Environment** and set `DASHBOARD_API_KEY` to a long random secret (at least 32 random characters). Save changes and redeploy/restart the service. Do not use your Discord bot token as this key.

After deployment, open `https://YOUR-RENDER-SERVICE.onrender.com/health`. It should return JSON with `ok: true` and `dashboardApiConfigured: true`. If it says `false`, the environment variable is missing or the service has not restarted. In the dashboard, enter the same service base URL (no `/health` and no trailing slash) and the same `DASHBOARD_API_KEY`, then use **Load from bot**.

Set `DASHBOARD_API_KEY` to a long random secret. Do not put the secret in a public website. This offline prototype asks for the key locally, which is suitable only for private testing. For a production hosted dashboard, replace shared-key browser auth with Discord OAuth and server-side sessions.

## API
- `GET /health` remains the health check.
- `GET /api/anti-spam` returns `{ ok: true, settings: {...} }`.
- `PUT /api/anti-spam` accepts `{ "settings": {...} }`.

## Permissions and behavior
The bot must have Manage Messages to delete messages and Moderate Members to time out users. Failed Discord actions are logged and do not crash the bot. `Warn` uses the existing warning pipeline, including the existing daily-warning escalation behavior.

## Test
1. Deploy the updated bot source to Render with `DASHBOARD_API_KEY` set.
2. Open the dashboard HTML locally.
3. Enter the HTTPS Render service URL and key.
4. Click **Load from bot**, adjust the rule, then click **Save to live bot**.
5. Test in a private channel first.
