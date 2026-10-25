# VR GAMERS Control Center — Role Shortcut API Fix

## Why the shortcut section failed
The dashboard called `/api/role-command-aliases`, but the deployed bot API did not register that endpoint. The browser therefore showed the generic “Could not reach the bot API” message.

## Install
1. Back up your current `Leader-main/index.js`.
2. Replace it with the included `index.js`.
3. Commit/push and redeploy the Render service.
4. Confirm Render has `DASHBOARD_API_KEY` set and that the dashboard uses the exact same key and the service's HTTPS base URL (no trailing slash is okay; the dashboard strips it).
5. Open Role Shortcuts and press reload. Add a shortcut and save it.

## What this patch does
- Registers the role-shortcut endpoint under the authenticated dashboard API router, including CORS preflight handling.
- Loads/saves shortcuts per Discord server in `dashboard-role-command-aliases.json`.
- Validates shortcut names, duplicate/reserved names, role existence, bot Manage Roles permission and role hierarchy.
- Runs saved shortcuts such as `?member @user`, using the same command policy as `giverole`.

## Notes
- The bot must have Manage Roles, and its highest role must be above the role the shortcut assigns.
- If Render uses an ephemeral filesystem, the JSON settings file may not survive redeploys. Use a persistent disk/database for durable settings.
- Never share `DASHBOARD_API_KEY` publicly.
