'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  throw new Error('Persistent settings require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const TABLE = 'bot_settings';
let initialized = false;
let writeQueue = Promise.resolve();
const failedWrites = new Map();
const MAX_RETRIES = 5;

function safeKey(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(__dirname, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || !relative.endsWith('.json')) {
    throw new Error('Refusing to persist a non-JSON file or a path outside the bot directory.');
  }
  return relative;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await operation();
      failedWrites.delete(label);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await sleep(300 * (2 ** (attempt - 1)));
    }
  }
  failedWrites.set(label, lastError || new Error('Unknown Supabase write error'));
  throw new Error(`Could not persist ${label} after ${MAX_RETRIES} attempts: ${lastError?.message || lastError}`);
}

async function writeSetting(key, value) {
  await withRetry(async () => {
    const { error } = await supabase.from(TABLE).upsert({
      key,
      value,
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) throw error;
  }, key);
}

async function initializePersistentJson() {
  if (initialized) return;

  const { data: rows, error } = await supabase.from(TABLE).select('key,value');
  if (error) {
    throw new Error(`Cannot load persistent settings from Supabase table '${TABLE}': ${error.message}. Run supabase-settings-setup.sql once.`);
  }

  const stored = new Set();
  for (const row of rows || []) {
    const key = safeKey(path.join(__dirname, String(row.key || '')));
    stored.add(key);
    const target = path.join(__dirname, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.restore.tmp`;
    fs.writeFileSync(temp, JSON.stringify(row.value ?? {}, null, 2), 'utf8');
    fs.renameSync(temp, target);
  }

  // Seed settings already present in the release only when Supabase has no row.
  const seedTasks = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json') && !['package.json', 'package-lock.json'].includes(entry.name) && !entry.name.endsWith('.tmp.json')) {
        const key = safeKey(fullPath);
        if (stored.has(key)) continue;
        try {
          const value = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          seedTasks.push(writeSetting(key, value));
          stored.add(key);
        } catch (error) {
          if (error instanceof SyntaxError) {
            console.warn(`[PERSISTENCE] Skipping invalid JSON ${key}: ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    }
  }
  walk(__dirname);
  await Promise.all(seedTasks);
  initialized = true;
  console.log(`[PERSISTENCE] Restored ${rows?.length || 0} settings file(s); seeded ${seedTasks.length} new file(s) into Supabase.`);
}

function persistJsonFile(filePath, value) {
  const key = safeKey(filePath);
  // Snapshot now so later mutations cannot alter the value queued for storage.
  const snapshot = JSON.parse(JSON.stringify(value));
  const operation = writeQueue.then(() => writeSetting(key, snapshot));
  // Keep the queue usable after a failure, but return the rejecting operation to callers.
  writeQueue = operation.catch(error => {
    console.error(`[PERSISTENCE] ${error.message}`);
  });
  return operation;
}

async function uploadAudioAsset(storagePath, buffer, contentType) {
  const { error } = await supabase.storage.from('leader-assets').upload(storagePath, buffer, {
    contentType,
    upsert: true
  });
  if (error) throw new Error(`Could not persist announcement audio in Supabase Storage: ${error.message}`);
}

async function downloadAudioAsset(storagePath, destinationPath) {
  const { data, error } = await supabase.storage.from('leader-assets').download(storagePath);
  if (error || !data) throw new Error(`Could not restore announcement audio from Supabase Storage: ${error?.message || 'No file returned'}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temp = `${destinationPath}.download.tmp`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, destinationPath);
  return destinationPath;
}

async function flushPersistentJson() {
  await writeQueue;
  if (failedWrites.size) {
    const [key, error] = failedWrites.entries().next().value;
    throw new Error(`One or more settings could not be saved. First failure: ${key}: ${error?.message || error}`);
  }
}

module.exports = {
  initializePersistentJson,
  persistJsonFile,
  flushPersistentJson,
  uploadAudioAsset,
  downloadAudioAsset
};
