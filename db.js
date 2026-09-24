const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

if (!config.supabaseUrl) {
  console.error("Missing SUPABASE_URL environment variable.");
  process.exit(1);
}
if (!config.supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const TABLE = "users";
const data = { users: {} };
let saveQueue = Promise.resolve();
const dirtyUsers = new Map();
const SAVE_RETRIES = 4;

function userKey(user) {
  return key(user.user_id, user.guild_id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function persistUser(snapshot) {
  let lastError = null;

  for (let attempt = 1; attempt <= SAVE_RETRIES; attempt++) {
    try {
      const { error } = await supabase
        .from(TABLE)
        .upsert(snapshot, { onConflict: "guild_id,user_id" });

      if (!error) {
        const current = dirtyUsers.get(userKey(snapshot));
        if (current && Number(current.updated_at) === Number(snapshot.updated_at)) {
          dirtyUsers.delete(userKey(snapshot));
        }
        return true;
      }

      lastError = error;
    } catch (err) {
      lastError = err;
    }

    if (attempt < SAVE_RETRIES) {
      await sleep(250 * 2 ** (attempt - 1));
    }
  }

  dirtyUsers.set(userKey(snapshot), { ...snapshot });
  console.error(
    `Could not save Supabase user ${snapshot.guild_id}:${snapshot.user_id} after ${SAVE_RETRIES} attempts:`,
    lastError?.message || lastError
  );
  return false;
}

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

function normalizeUser(row) {
  return {
    user_id: String(row.user_id),
    guild_id: String(row.guild_id),
    messages: Number(row.messages || 0),
    vc_seconds: Number(row.vc_seconds || 0),
    vehicle_index: Number(row.vehicle_index || 0),
    last_vc_join:
      row.last_vc_join === null || row.last_vc_join === undefined
        ? null
        : Number(row.last_vc_join),
    updated_at: Number(row.updated_at || 0),
    instagram: row.instagram || null
  };
}

function queueSave(user) {
  const snapshot = { ...user };
  dirtyUsers.set(userKey(snapshot), snapshot);

  saveQueue = saveQueue.then(async () => {
    const latest = dirtyUsers.get(userKey(snapshot));
    if (!latest) return;
    await persistUser({ ...latest });
  });

  // Keep callers non-blocking while still exposing the shared queue for shutdown.
  return saveQueue;
}

async function flushDirtyUsers() {
  const snapshots = [...dirtyUsers.values()].map(user => ({ ...user }));
  if (!snapshots.length) return;

  for (const snapshot of snapshots) {
    await persistUser(snapshot);
  }
}

async function loadAllUsers() {
  const pageSize = 1000;
  let from = 0;
  let rows = [];

  while (true) {
    const { data: page, error } = await supabase
      .from(TABLE)
      .select("user_id,guild_id,messages,vc_seconds,vehicle_index,last_vc_join,updated_at,instagram")
      .range(from, from + pageSize - 1);

    if (error) throw error;

    rows = rows.concat(page || []);

    if (!page || page.length < pageSize) break;
    from += pageSize;
  }

  for (const row of rows) {
    const user = normalizeUser(row);
    data.users[key(user.user_id, user.guild_id)] = user;
  }

  return rows.length;
}

async function init() {
  const count = await loadAllUsers();
  console.log(`Supabase connected. Users loaded: ${count}`);
}

function ensureUser(userId, guildId) {
  const k = key(userId, guildId);

  if (!data.users[k]) {
    data.users[k] = {
      user_id: String(userId),
      guild_id: String(guildId),
      messages: 0,
      vc_seconds: 0,
      vehicle_index: 0,
      last_vc_join: null,
      instagram: null, 
      updated_at: Math.floor(Date.now() / 1000)
    };

    queueSave(data.users[k]);
  }

  return data.users[k];
}

// Return a display snapshot with the currently running VC session included.
// IMPORTANT: this does NOT add the live seconds to the stored total, so
// calling getUser() repeatedly cannot double-count VC time.
function withLiveVcTime(user, now = Date.now()) {
  const snapshot = { ...user };

  if (snapshot.last_vc_join !== null && snapshot.last_vc_join !== undefined) {
    const elapsed = Math.floor(
      (now - Number(snapshot.last_vc_join)) / 1000
    );

    if (Number.isFinite(elapsed) && elapsed > 0) {
      snapshot.vc_seconds += elapsed;
    }
  }

  return snapshot;
}

function getUser(userId, guildId) {
  return withLiveVcTime(ensureUser(userId, guildId));
}

function update(userId, guildId, changes) {
  const user = ensureUser(userId, guildId);

  Object.assign(user, changes, {
    updated_at: Math.floor(Date.now() / 1000)
  });

  queueSave(user);
  return { ...user };
}

function addMessage(userId, guildId, count = 1) {
  const user = ensureUser(userId, guildId);
  user.messages += Math.max(0, Math.floor(count));
  user.updated_at = Math.floor(Date.now() / 1000);
  queueSave(user);
}

function addVcSeconds(userId, guildId, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  const user = ensureUser(userId, guildId);
  user.vc_seconds += Math.floor(seconds);
  user.updated_at = Math.floor(Date.now() / 1000);
  queueSave(user);
}

function setVcJoin(userId, guildId, timestamp) {
  update(userId, guildId, {
    last_vc_join: Number(timestamp)
  });
}

function clearVcJoin(userId, guildId) {
  update(userId, guildId, {
    last_vc_join: null
  });
}

// Convert the active VC session into saved VC seconds exactly once.
// This is used when a member leaves VC and during graceful shutdown.
function settleVcSession(userId, guildId, now = Date.now()) {
  const user = ensureUser(userId, guildId);

  if (user.last_vc_join === null || user.last_vc_join === undefined) {
    return { ...user };
  }

  const elapsed = Math.floor(
    (now - Number(user.last_vc_join)) / 1000
  );

  if (Number.isFinite(elapsed) && elapsed > 0) {
    user.vc_seconds += elapsed;
  }

  user.last_vc_join = null;
  user.updated_at = Math.floor(now / 1000);
  queueSave(user);

  return { ...user };
}

function setVehicleIndex(userId, guildId, index) {
  update(userId, guildId, {
    vehicle_index: Math.max(0, Math.floor(index))
  });
}

function topUsers(guildId, limit = 10) {
  return Object.values(data.users)
    .filter(user => user.guild_id === guildId)
    .map(withLiveVcTime)
    .sort((a, b) =>
      b.vehicle_index - a.vehicle_index ||
      b.vc_seconds - a.vc_seconds ||
      b.messages - a.messages
    )
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(user => ({ ...user }));
}

const dirtyFlushTimer = setInterval(() => {
  saveQueue = saveQueue
    .then(() => flushDirtyUsers())
    .catch(err => console.error("Supabase dirty-user flush error:", err));
}, 30000);
dirtyFlushTimer.unref?.();

async function close() {
  const now = Date.now();

  // Save all active VC sessions before shutdown.
  for (const user of Object.values(data.users)) {
    if (user.last_vc_join !== null && user.last_vc_join !== undefined) {
      const elapsed = Math.floor(
        (now - Number(user.last_vc_join)) / 1000
      );

      if (Number.isFinite(elapsed) && elapsed > 0) {
        user.vc_seconds += elapsed;
      }

      user.last_vc_join = null;
      user.updated_at = Math.floor(now / 1000);
      queueSave(user);
    }
  }

  await saveQueue;
  await flushDirtyUsers();
  clearInterval(dirtyFlushTimer);
}
function setInstagram(userId, guildId, username) {
  return update(userId, guildId, {
    instagram: username
  });
}

function removeInstagram(userId, guildId) {
  return update(userId, guildId, {
    instagram: null
  });
}


// Reset gameplay/progression values in the in-memory legacy cache as well as Supabase.
// This prevents stale cached vehicle_index/messages/VC values from being written back.
function resetUserProgress(userId, guildId) {
  const user = ensureUser(userId, guildId);
  user.messages = 0;
  user.vc_seconds = 0;
  user.vehicle_index = 0;
  user.last_vc_join = null;
  user.updated_at = Math.floor(Date.now() / 1000);
  queueSave(user);
  return { ...user };
}

module.exports = {
  init,
  ensureUser,
  getUser,
  addMessage,
  addVcSeconds,
  setVcJoin,
  clearVcJoin,
  settleVcSession,
  setVehicleIndex,
  resetUserProgress,
  topUsers,
  setInstagram,
  removeInstagram,
close
};
