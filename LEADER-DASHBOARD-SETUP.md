# LEADER Control Center — Install notes

## Files in this update
- `index.js` — adds the server-side role shortcut API and command handler, fixes role hierarchy flags returned to the dashboard, and allows the browser to make DELETE requests for role deletion.
- `LEADER-dashboard-v4-connected.html` — replaces the old demo interface with a mobile-first dashboard that uses the existing authenticated APIs.

## Install
1. Back up the current project.
2. Replace `index.js` and `LEADER-dashboard-v4-connected.html` in your `Leader-main` folder with these versions.
3. Commit/push and redeploy the existing Render service.
4. In Render, make sure `DASHBOARD_API_KEY` is set to a long secret (at least 32 characters). Do not use your Discord bot token as this key.
5. Open the HTML file in your browser, enter the Render service URL (no `/health` and no trailing slash), the same dashboard API key, and your server ID.
6. Connect. Try reading Auto Roles and roles first, then save a harmless test setting.

## Dashboard panels that use real bot APIs
- Overview / live stats: `/api/dashboard-stats`
- Auto Roles: `/api/auto-roles`
- Roles & permissions: `/api/discord-roles`, `/api/discord-role`
- Command settings: `/api/command-manager`
- Role shortcuts: `/api/role-command-aliases` (new)
- Anti-spam: `/api/anti-spam`
- Message studio: `/api/discord-channels`, `/api/send-message`

## Role shortcuts
Create a shortcut by choosing a role and a name, for example `member`. Once saved, staff with the same permission to use the built-in role-giving command can use:

`?member @user`

LEADER assigns the role selected for that shortcut. The shortcut must be 2–32 characters, start with a letter, and may contain letters, numbers, hyphens, or underscores. Built-in command names cannot be reused. Shortcuts are stored per server in `dashboard-role-command-aliases.json`.

## Notes
- The website does not claim that unsupported prototype panels (tickets, leveling, workflow builder, scheduled messages, database backups) are implemented.
- LEADER needs the relevant Discord permissions. Its highest role must be above any role it is expected to edit or assign.
- The dashboard uses a shared API key in the browser for this existing private setup. Keep the key private and use HTTPS. A production public-facing site should use Discord OAuth and server-side sessions.
- Validate changes on a test server first. Dashboard API settings are real changes, not preview-only.
