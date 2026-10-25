# VR GAMERS — CONTROL CENTER redesign

## Included
- `LEADER-dashboard-v4-connected.html`: responsive redesign, dashboard-wide feature search, role/permission search, role table search, auto-role search, log-category search, and restored Give-role shortcuts UI.

## Install
1. Back up the currently deployed project.
2. Replace `Leader-main/LEADER-dashboard-v4-connected.html` with this version.
3. Keep the current `index.js` from the Role Permissions Fix release. The Give-role shortcut screen requires the existing authenticated `/api/role-command-aliases` endpoint and bot command handler.
4. Commit/push and redeploy, then refresh the dashboard in the browser.
5. Open **Give-role shortcuts**. Create a command name such as `member`, select a role, add it, then click **Save shortcuts to bot**. Usage is `?member @user`.

## Search
- The top search opens any dashboard section. On desktop, Ctrl+K / Cmd+K focuses it.
- Roles & Permissions has role search and the detailed permission editor has permission search.
- Command Settings already has command search and category filters.
- Give-role shortcuts has command/role search.
- Auto Roles and Moderation Logs include search fields.

## Important
This package changes the dashboard HTML only; it does not replace or rewrite bot features. Shortcuts still depend on the API/handler being present in the currently deployed `index.js`. Run a live server test after redeployment because static checks cannot verify Discord permissions or API connectivity.
