LEADER Discord bot

Use `npm start` (which restores Supabase settings before starting `bot.js`). `index.js`, `bootstrap.js`, and the legacy `LEADER-index.js` all route through the same restore step. Before the first deploy, run `supabase-settings-setup.sql` in the Supabase SQL Editor and configure the environment variables listed in `render.yaml`. See `PERSISTENT-SETTINGS-SETUP.md` for deployment and migration instructions.
