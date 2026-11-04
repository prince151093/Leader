# LEADER persistent settings and data

Render's normal filesystem is temporary. LEADER now stores JSON configuration and progression snapshots in Supabase, stores announcement audio in a private Supabase Storage bucket, and keeps activity, warnings and giveaways in their Supabase tables.

## One-time setup

1. Open **Supabase → SQL Editor**.
2. Run the complete `supabase-settings-setup.sql` file in this ZIP.
3. In Render, keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured. The service-role key must remain server-side and must never be placed in the dashboard HTML.
4. Keep `DASHBOARD_API_KEY` configured in Render and use the same dashboard key when connecting.
5. Deploy this release. `index.js` (also used by `npm start`) waits for Supabase, restores the saved JSON files, and only then loads `bot.js`. The `bootstrap.js` and legacy `LEADER-index.js` files remain as compatibility wrappers for older start commands; all supported entry points restore settings before starting `bot.js`.
6. Change one setting in the dashboard, wait for the successful save response, then redeploy and verify that the setting remains.

## Save and restore behavior

- Dashboard settings are written to Supabase before the API reports a successful save.
- Bot JSON settings are queued to Supabase immediately and flushed during graceful shutdown.
- Progression snapshots are saved to Supabase and restored before the bot starts.
- Giveaway entries are stored in the `giveaways` table after each successful join.
- VC announcement audio is uploaded to the private `leader-assets` bucket and restored to a local cache when needed.
- Render should remain at **one running instance** because Discord event/session state is held in memory. Supabase persists settings/data but does not coordinate multiple live bot instances.

## Important migration note

The first deployment seeds configuration JSON files included in the release into Supabase only when a matching Supabase key does not already exist. Settings that exist only on an old temporary Render filesystem cannot be recovered by a new container after that filesystem has already been replaced. If the old settings are still accessible in the currently running instance, they must be exported before its filesystem is discarded. After the first successful save, future GitHub deployments and restarts restore from Supabase automatically.
