# VR GAMERS — CONTROL CENTER

This update replaces the old prototype-style dashboard with a mobile-responsive dashboard that calls the running LEADER bot API. Giveaway UI has been omitted.

## Changed files

- `LEADER-dashboard-v4-connected.html` — new responsive dashboard, animated navigation/cards, live connection status, settings forms and live previews.
- `index.js` — authenticated APIs for moderator alert settings and moderation log channels; adds the special-welcome and moderator-alert routes to the authenticated API router; enables CORS preflight for role deletion.
- `special-welcome.js` — guild-specific enabled state and configurable join/banner message templates while preserving the existing `?setspecialwelcomechannel` command and banner renderer.

## Dashboard features connected to bot APIs

- Overview and real server statistics.
- Special Welcome: channel, enabled/disabled state, join notification template and `?w` banner text template.
- Moderator Alerts: alert channel, India-time schedule, minimum VC seconds, minimum chat messages, VC moderator role, chat moderator role and test alert.
- Moderation Logs: separate destinations for moderation, message, voice, channel, role and member events.
- Auto Roles: load assignable roles and save the list used by the bot for new members.
- Roles & Permissions: create/edit/delete roles, with Discord role-hierarchy protections; permission edits use a limited allowlist in the UI.
- Command Settings: list implemented prefix commands, enable/disable and configure supported policy restrictions.
- Anti-spam: live threshold/window/action/exemptions settings.
- Message Studio: send a plain message or embed to a selected text channel.

## Deploy

1. Back up your repository.
2. Replace the three changed source files with the versions in this package, keeping the paths under `Leader-main/`.
3. Confirm Render has `DISCORD_TOKEN`, `CLIENT_ID`, and `DASHBOARD_API_KEY`. The dashboard API key must be a strong private secret; never use the Discord bot token as the dashboard key.
4. Push the changes and redeploy the Render service.
5. Open the HTML dashboard locally or from a private trusted location. Enter the Render base URL (without `/health` or a trailing slash), the same `DASHBOARD_API_KEY`, and your Discord server ID. Press **Connect & load**.
6. Test settings in a private channel first. Confirm the bot has the required channel permissions and its highest role is above any role it must manage.

## Template variables

The special welcome templates support `{user}`, `{member}`, `{username}`, `{server}`, `{memberCount}`, `{welcomer}`, and `{pronoun}`. The bot replaces these when it sends the relevant message. Preview text in the dashboard uses sample values only.

## Important limitations and operational notes

- Static syntax checks passed for `index.js`, `special-welcome.js`, and the dashboard JavaScript. This is not a live Discord/Render integration test; the bot must be deployed and tested against your server.
- JSON settings such as `special-welcome-config.json`, `moderator-alerts.json`, `moderation-logs.json`, `autoroles.json`, and dashboard settings are stored on the service filesystem, consistent with the existing bot. Render free services generally have ephemeral filesystems; settings written locally may be lost when the service is replaced/redeployed. Use a persistent disk where supported or move these settings to durable storage before relying on them for production.
- The dashboard uses a private shared API key for this local/private workflow. Do not publish the HTML with a real key embedded in it. A publicly hosted dashboard should use Discord OAuth and server-side sessions.
- The website exposes implemented bot features only; it does not add giveaways, fake workflow builders, fake ticket controls, or a simulated historical log viewer.
