'use strict';

// Keep the conventional `node index.js` / `npm start` entry point safe:
// never load the Discord bot until persistent settings have been restored.
const { initializePersistentJson } = require('./persistent-json');

(async () => {
  try {
    await initializePersistentJson();
    process.env.LEADER_SETTINGS_RESTORED = '1';
    require('./bot');
  } catch (error) {
    console.error('[PERSISTENCE] Startup stopped to protect settings:', error.message);
    process.exit(1);
  }
})();
