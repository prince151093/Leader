/* Leader - Discord connection diagnostics enabled */
const giveawayCommand = require("./src/commands/giveaway");
const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder
} = require("discord.js");

const config = require("./config");

const {
  getUser,
  addMessage,
  addVcSeconds,
  settleVcSession,
  setVcJoin,
  clearVcJoin,
  topUsers,
  setInstagram,
  removeInstagram,
  close: closeDb,
  init: initDb
} = require("./db");

const {
  initProgression,
  recordMessageActivity,
  recordNewMember,
  startVcSession,
  endVcSession,
  restoreVoiceSessions,
  updatePeakOnline,
  getDayStats,
  getProgressionImages,
  setDailyReportRole,
  setProgressViewChannel,
  getProgressSettings,
  markDailyReportSent,
  wasDailyReportSent,
  previousDayKey,
  dateKey,
  TIME_ZONE
} = require("./progression");

/* =========================
   CONFIG CHECK
========================= */

if (!config.token) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
if (!config.clientId) {
  console.error("Missing CLIENT_ID environment variable.");
  process.exit(1);
}

/* =========================
   HEALTH SERVER
========================= */

let healthServer = null;

function startHealthServer() {
  const port = Number(process.env.PORT);

  if (!port) return;

  healthServer = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const ready = client?.isReady?.() === true;
      res.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });

      res.end(JSON.stringify({
        ok: ready,
        service: "Leader",
        uptime: Math.round(process.uptime()),
        discordReady: ready
      }) + "\n");
      return;
    }

    res.writeHead(404);
    res.end("Not found\n");
  });

  healthServer.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });
}

startHealthServer();

/* =========================
   CHANNEL SHORTCUTS
========================= */

const CHANNEL_SHORTCUTS_FILE = path.join(__dirname, "channel-shortcuts.json");
let channelShortcuts = {};

function loadChannelShortcuts() {
  try {
    if (fs.existsSync(CHANNEL_SHORTCUTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNEL_SHORTCUTS_FILE, "utf8"));
      channelShortcuts = data && typeof data === "object" ? data : {};
    }
  } catch (err) {
    console.error("Channel shortcut load error:", err);
    channelShortcuts = {};
  }
}

function saveChannelShortcuts() {
  try {
    fs.writeFileSync(CHANNEL_SHORTCUTS_FILE, JSON.stringify(channelShortcuts, null, 2));
  } catch (err) {
    console.error("Channel shortcut save error:", err);
  }
}

loadChannelShortcuts();
initProgression();

function shortcutName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function expandChannelShortcuts(content, guildId) {
  const guildShortcuts = channelShortcuts[guildId] || {};
  return String(content).replace(/\?m\s+([a-zA-Z0-9_-]+)/gi, (full, rawName) => {
    const name = shortcutName(rawName);
    const channelId = guildShortcuts[name];
    return channelId ? `<#${channelId}>` : full;
  });
}

/* =========================
   DISCORD CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ],
  partials: [
    Partials.Channel
  ]
});

/* =========================
   DISCORD DIAGNOSTICS
========================= */

client.on("error", error => {
  console.error("DISCORD CLIENT ERROR:", error);
});

client.on("warn", warning => {
  console.warn("DISCORD CLIENT WARNING:", warning);
});

client.on("debug", message => {
  // discord.js debug output can contain the bot token during login.
  // Never log authentication tokens or token-bearing debug messages.
  const msg = String(message);
  if (/token|authorization|authenticate/i.test(msg)) return;
  console.log("DISCORD DEBUG:", msg);
});

// Gateway lifecycle diagnostics
client.on("shardReady", (id, unavailableGuilds) => {
  console.log(
    `DISCORD SHARD READY: shard=${id} unavailableGuilds=${unavailableGuilds ? unavailableGuilds.size : 0}`
  );
});

client.on("shardReconnecting", id => {
  console.log(`DISCORD SHARD RECONNECTING: shard=${id}`);
});

client.on("shardDisconnect", (closeEvent, id) => {
  console.error(
    `DISCORD SHARD DISCONNECT: shard=${id} code=${closeEvent?.code ?? "unknown"} reason=${closeEvent?.reason || "unknown"}`
  );
});

client.on("shardResume", (id, replayedEvents) => {
  console.log(
    `DISCORD SHARD RESUMED: shard=${id} replayedEvents=${replayedEvents}`
  );
});

client.on("invalidated", () => {
  console.error("DISCORD SESSION INVALIDATED: Discord invalidated the gateway session.");
});

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  giveawayCommand.data
].map(command => command.toJSON());

/* =========================
   DEPLOY COMMANDS
========================= */

async function deployCommands() {
  const rest = new REST({
    version: "10"
  }).setToken(config.token);

  if (config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(
        config.clientId,
        config.guildId
      ),
      {
        body: commands
      }
    );

    console.log("Guild slash commands registered.");
  } else {
    await rest.put(
      Routes.applicationCommands(config.clientId),
      {
        body: commands
      }
    );

    console.log("Global slash commands registered.");
  }
}


/* =========================
   MODERATION LOGS + WARNINGS
========================= */

const MODLOG_CONFIG_FILE = path.join(__dirname, "moderation-logs.json");
const WARNINGS_FILE = path.join(__dirname, "moderation-warnings.json");
let moderationLogConfig = loadJson(MODLOG_CONFIG_FILE, {});
let moderationWarnings = loadJson(WARNINGS_FILE, {});

// Automatic roles for new members. Configure with ?setautorole @role ...
const AUTOROLE_CONFIG_FILE = path.join(__dirname, "autoroles.json");
let autoRoleConfig = loadJson(AUTOROLE_CONFIG_FILE, {});
const pendingAutoRoleAssignments = new Map();

// Migrate the older format ({ guildId: channelId }) to the new per-category
// format without breaking existing installations.
for (const [guildId, value] of Object.entries(moderationLogConfig)) {
  if (typeof value === "string") {
    moderationLogConfig[guildId] = {
      mod: value,
      message: value,
      voice: value,
      channel: value,
      role: value,
      member: value
    };
  } else if (!value || typeof value !== "object") {
    moderationLogConfig[guildId] = {};
  }
}
saveJson(MODLOG_CONFIG_FILE, moderationLogConfig);
const antiSpamState = new Map();
const MEDIA_ONLY_FILE = path.join(__dirname, "media-only.json");
const mediaOnlyChannels = new Set(Object.keys(loadJson(MEDIA_ONLY_FILE, {})));

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch (err) {
    console.error(`Could not load ${file}:`, err);
    return fallback;
  }
}

function saveJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`Could not save ${file}:`, err);
  }
}

function getAutoRoleIds(guildId) {
  const value = autoRoleConfig[guildId];
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function saveAutoRoles() {
  saveJson(AUTOROLE_CONFIG_FILE, autoRoleConfig);
}

function formatRoleMentions(guild, roleIds) {
  return roleIds.map(id => guild.roles.cache.get(id)).filter(Boolean).map(role => `<@&${role.id}>`).join(" ");
}

function normalizeSpamText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function warningKey(guildId, userId) { return `${guildId}:${userId}`; }

function pruneWarnings(guildId, userId) {
  const key = warningKey(guildId, userId);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const list = Array.isArray(moderationWarnings[key]) ? moderationWarnings[key] : [];
  const fresh = list.filter(w => Number(w.timestamp) > cutoff);
  moderationWarnings[key] = fresh;
  return fresh;
}

function addWarning(guildId, userId, data) {
  const key = warningKey(guildId, userId);
  const list = pruneWarnings(guildId, userId);
  const caseId = `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const entry = { caseId, timestamp: Date.now(), ...data };
  list.push(entry);
  moderationWarnings[key] = list;
  saveJson(WARNINGS_FILE, moderationWarnings);
  return entry;
}

function removeLatestWarning(guildId, userId) {
  const key = warningKey(guildId, userId);
  const list = pruneWarnings(guildId, userId);
  if (!list.length) return null;
  const removed = list.pop();
  moderationWarnings[key] = list;
  saveJson(WARNINGS_FILE, moderationWarnings);
  return removed;
}

function getWarnings(guildId, userId) {
  return pruneWarnings(guildId, userId);
}

function logCategoryForType(type) {
  if (["messageDelete", "messageEdit"].includes(type)) return "message";
  if (["voice"].includes(type)) return "voice";
  if (["channel"].includes(type)) return "channel";
  if (["role"].includes(type)) return "role";
  if (["memberJoin", "memberLeave", "memberUpdate"].includes(type)) return "member";
  return "mod";
}

function configuredLogChannel(guild, category) {
  const settings = moderationLogConfig[guild.id];
  if (!settings || typeof settings !== "object") return null;
  const id = settings[category];
  const channel = id ? guild.channels.cache.get(id) : null;
  return channel?.isTextBased() ? channel : null;
}

function modLogChannel(guild) {
  return configuredLogChannel(guild, "mod");
}

async function sendModerationLog(guild, type, data = {}) {
  const channel = configuredLogChannel(guild, logCategoryForType(type));
  if (!channel) return;
  const colors = {
    messageDelete: 0xE74C3C, messageEdit: 0xF1C40F, memberJoin: 0x2ECC71, memberLeave: 0x95A5A6,
    ban: 0xC0392B, unban: 0x27AE60, kick: 0xE67E22, timeout: 0xE67E22, unmute: 0x2ECC71, role: 0x9B59B6, channel: 0x3498DB,
    voice: 0x5865F2, warning: 0xF39C12, unwarning: 0x2ECC71, purge: 0xE67E22
  };
  const titles = {
    messageDelete: "🗑️ Message Deleted", messageEdit: "✏️ Message Edited", memberJoin: "📥 Member Joined",
    memberLeave: "📤 Member Left", ban: "🔨 Member Banned", unban: "🔓 Member Unbanned", kick: "👢 Member Kicked", timeout: "🔇 Member Timed Out", unmute: "🔊 Timeout Removed",
    role: "🎭 Role Updated", channel: "📺 Channel Updated", voice: "🔊 Voice Activity", warning: "⚠️ Warning Issued",
    unwarning: "✅ Warning Removed", purge: "🧹 Messages Purged"
  };
  const embed = new EmbedBuilder()
    .setTitle(titles[type] || "🛡️ Moderation Log")
    .setColor(colors[type] || 0x5865F2)
    .setTimestamp();
  if (data.user) embed.addFields({ name: "Member", value: `${data.user}`, inline: true });
  if (data.channel) embed.addFields({ name: "Channel", value: `${data.channel}`, inline: true });
  if (data.moderator) embed.addFields({ name: "Moderator", value: `${data.moderator}`, inline: true });
  if (data.action) embed.addFields({ name: "Action", value: String(data.action), inline: true });
  if (data.reason) embed.addFields({ name: "Reason", value: String(data.reason).slice(0, 1024), inline: false });
  if (data.content) embed.addFields({ name: "Content", value: String(data.content).slice(0, 1024), inline: false });
  if (data.before) embed.addFields({ name: "Before", value: String(data.before).slice(0, 1024), inline: false });
  if (data.after) embed.addFields({ name: "After", value: String(data.after).slice(0, 1024), inline: false });
  if (data.caseId) embed.addFields({ name: "Case ID", value: `\`${data.caseId}\``, inline: true });
  if (data.details) embed.setDescription(String(data.details).slice(0, 4096));
  embed.setFooter({ text: "Leader • Moderation Logs" });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(err => console.error("Moderation log send error:", err));
}

async function auditExecutor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const now = Date.now();
    const entry = logs.entries.find(e => e.target?.id === targetId && now - e.createdTimestamp < 10000);
    return entry?.executor || null;
  } catch { return null; }
}

async function issueWarning(guild, targetMember, moderator, reason, automatic = false) {
  const entry = addWarning(guild.id, targetMember.id, {
    reason, moderatorId: moderator?.id || null, automatic
  });
  const count = getWarnings(guild.id, targetMember.id).length;
  await sendModerationLog(guild, "warning", {
    user: `${targetMember}`, moderator: moderator ? `${moderator}` : "Leader (automatic)", reason, caseId: entry.caseId,
    details: `${automatic ? "Automatic anti-spam warning" : "Manual moderator warning"}\nDaily warnings: **${count}/3**`
  });
  if (count >= 3) {
    await targetMember.timeout(60 * 60 * 1000, "3 warnings in one day").catch(() => {});
    await sendModerationLog(guild, "timeout", {
      user: `${targetMember}`, moderator: "Leader (automatic)", reason: "3 warnings in one day", caseId: entry.caseId,
      details: "Automatic 1-hour timeout triggered by the daily warning threshold."
    });
  }
  return entry;
}

async function processAntiSpam(message) {
  if (!message.content.trim()) return;
  const key = `${message.guild.id}:${message.author.id}`;
  const normalized = normalizeSpamText(message.content);
  const now = Date.now();
  const state = antiSpamState.get(key);
  if (!state || state.text !== normalized || now - state.lastAt > 60 * 1000) {
    antiSpamState.set(key, { text: normalized, count: 1, lastAt: now, warned: false });
    return;
  }
  state.count += 1;
  state.lastAt = now;
  if (state.count === 3 && !state.warned) {
    state.warned = true;
    const member = message.member;
    if (member) await issueWarning(message.guild, member, null, `Repeated the same message 3 times within 1 minute: ${message.content}`, true);
  }
}

/* =========================
   DAILY MODERATOR ALERTS
========================= */

const MOD_ALERT_FILE = path.join(__dirname, "moderator-alerts.json");
const MOD_ALERT_PASSWORD = "admin@151093";
const MOD_ALERT_TIME_ZONE = "Asia/Kolkata";
const modAlertState = loadJson(MOD_ALERT_FILE, {});
const activeModVoice = new Map();

function modAlertDefault() {
  return {
    channelId: null,
    alertTime: "07:30",
    minVcSeconds: 10800,
    minChatMessages: 300,
    vcRoleId: null,
    chatRoleId: null,
    activity: {},
    lastAlertDate: null
  };
}

function getModAlertState(guildId) {
  if (!modAlertState[guildId]) modAlertState[guildId] = modAlertDefault();
  return modAlertState[guildId];
}

function saveModAlertState() {
  saveJson(MOD_ALERT_FILE, modAlertState);
}

function alertDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MOD_ALERT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function alertClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MOD_ALERT_TIME_ZONE,
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return `${parts.find(p => p.type === "hour")?.value || "00"}:${parts.find(p => p.type === "minute")?.value || "00"}`;
}

function parseAlertTime(value) {
  const m = String(value || "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    if (m[3] === "am" && hour === 12) hour = 0;
    if (m[3] === "pm" && hour !== 12) hour += 12;
  }
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseVcRequirement(value) {
  const raw = String(value || "").trim().toLowerCase();
  let m = raw.match(/^(\d+(?:\.\d+)?)h$/);
  if (m) return Math.round(Number(m[1]) * 3600);
  m = raw.match(/^(\d+)\s*:\s*(\d+)h$/);
  if (m) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (minutes > 59) return null;
    return hours * 3600 + minutes * 60;
  }
  return null;
}

function formatDurationShort(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

function modActivity(guildId, userId) {
  const st = getModAlertState(guildId);
  const day = alertDateKey();
  st.activity[day] ??= {};
  st.activity[day][userId] ??= { messages: 0, vcSeconds: 0 };
  return st.activity[day][userId];
}

function recordModChatActivity(message) {
  const st = getModAlertState(message.guild.id);
  if (!st.chatRoleId || !message.member?.roles.cache.has(st.chatRoleId)) return;
  modActivity(message.guild.id, message.author.id).messages += 1;
  saveModAlertState();
}

function startModVoiceTracking(oldState, newState) {
  const member = newState.member || oldState.member;
  const st = getModAlertState(newState.guild.id);
  if (!member || member.user.bot || !st.vcRoleId || !newState.channelId || !member.roles.cache.has(st.vcRoleId)) return;
  activeModVoice.set(`${newState.guild.id}:${member.id}`, Date.now());
}

function endModVoiceTracking(state) {
  const key = `${state.guild.id}:${state.id}`;
  const started = activeModVoice.get(key);
  if (!started) return;
  const seconds = Math.floor((Date.now() - started) / 1000);
  if (seconds > 0) modActivity(state.guild.id, state.id).vcSeconds += seconds;
  activeModVoice.delete(key);
  saveModAlertState();
}

function updateActiveModVoice() {
  const now = Date.now();
  for (const [key, started] of activeModVoice) {
    const [guildId, userId] = key.split(":");
    const seconds = Math.floor((now - started) / 1000);
    if (seconds > 0) {
      modActivity(guildId, userId).vcSeconds += seconds;
      activeModVoice.set(key, now);
    }
  }
}

function alertPasswordValid(content) {
  const args = String(content).trim().split(/\s+/);
  return args[args.length - 1] === MOD_ALERT_PASSWORD;
}

async function requireAlertPassword(message) {
  const valid = alertPasswordValid(message.content);
  // Always remove the original password-containing command immediately.
  await message.delete().catch(() => {});
  if (!valid) {
    const reply = await message.channel.send(`${message.author} ❌ Invalid configuration password.`).catch(() => null);
    if (reply) setTimeout(() => reply.delete().catch(() => {}), 5000);
    return false;
  }
  return true;
}

async function sendDailyModAlert(guild, force = false) {
  const st = getModAlertState(guild.id);
  if (!st.channelId) return false;
  const channel = guild.channels.cache.get(st.channelId);
  if (!channel?.isTextBased()) return false;

  const today = alertDateKey();
  if (!force && st.lastAlertDate === today) return false;

  await guild.members.fetch().catch(() => null);
  updateActiveModVoice();

  const vcMissing = [];
  const chatMissing = [];
  const vcRequired = Number(st.minVcSeconds) || 0;
  const chatRequired = Number(st.minChatMessages) || 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const activity = modActivity(guild.id, member.id);

    if (st.vcRoleId && member.roles.cache.has(st.vcRoleId) && Number(activity.vcSeconds) < vcRequired) {
      vcMissing.push(`${member}`);
    }
    if (st.chatRoleId && member.roles.cache.has(st.chatRoleId) && Number(activity.messages) < chatRequired) {
      chatMissing.push(`${member}`);
    }
  }

  const vcSection = vcMissing.length
    ? vcMissing.join(" ")
    : "All VC moderators met the daily VC requirement.";
  const chatSection = chatMissing.length
    ? chatMissing.join(" ")
    : "All Chat moderators met the daily message requirement.";

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Daily Moderator Activity Alert")
    .setColor((vcMissing.length || chatMissing.length) ? 0xE67E22 : 0x2ECC71)
    .addFields(
      {
        name: "🎙️ VC MODERATORS",
        value: `${vcSection}\n\nRequired: **${formatDurationShort(vcRequired)} VC time**`,
        inline: false
      },
      {
        name: "💬 CHAT MODERATORS",
        value: `${chatSection}\n\nRequired: **${chatRequired} messages**`,
        inline: false
      }
    )
    .setFooter({ text: `Leader • Daily requirements • ${MOD_ALERT_TIME_ZONE}` })
    .setTimestamp();

  await channel.send({
    content: [...vcMissing, ...chatMissing].join(" ") || undefined,
    embeds: [embed],
    allowedMentions: { users: [...new Set([...vcMissing, ...chatMissing].map(x => x.match(/<@(\d+)>/)?.[1]).filter(Boolean))] }
  }).catch(err => console.error("Daily moderator alert error:", err));

  if (!force) {
    st.lastAlertDate = today;
    saveModAlertState();
  }
  return true;
}

setInterval(() => {
  updateActiveModVoice();
  const now = new Date();
  const current = alertClock(now);
  for (const guild of client.guilds.cache.values()) {
    const st = getModAlertState(guild.id);
    if (!st.channelId || st.lastAlertDate === alertDateKey(now)) continue;
    if (current >= (st.alertTime || "07:30")) {
      sendDailyModAlert(guild).catch(err => console.error("Moderator alert scheduler error:", err));
    }
  }
}, 15000);

/* =========================
   RESTORE VC SESSIONS
========================= */

function restoreActiveVoiceSessions() {
  let restored = 0;

  for (
    const guild of client.guilds.cache.values()
  ) {
    for (
      const state of guild.voiceStates.cache.values()
    ) {
      if (!state.channelId) {
        continue;
      }

      const member = state.member;

      if (member?.user?.bot) {
        continue;
      }

      const user = getUser(
        state.id,
        guild.id
      );

      if (
        user.last_vc_join === null ||
        user.last_vc_join === undefined
      ) {
        setVcJoin(
          state.id,
          guild.id,
          Date.now()
        );

        restored++;
      }
    }
  }

  console.log(
    `Restored ${restored} active VC session(s).`
  );
}

/* =========================
   DAILY SERVER PROGRESSION REPORT
========================= */

function updatePeakOnlineForAllGuilds() {
  for (const guild of client.guilds.cache.values()) {
    try {
      updatePeakOnline(guild);
    } catch (err) {
      console.error(`Peak-online update error for ${guild.id}:`, err);
    }
  }
}

async function sendDailyProgressReport(guild, reportDayKey) {
  const settings = getProgressSettings(guild.id);
  if (!settings.progressViewChannelId || !settings.dailyReportRoleId) return false;
  if (wasDailyReportSent(guild.id, reportDayKey)) return false;

  const channel = guild.channels.cache.get(settings.progressViewChannelId);
  if (!channel?.isTextBased()) return false;

  const stats = getDayStats(guild.id, reportDayKey);
  const images = await getProgressionImages(guild.id, 7, reportDayKey);
  const role = guild.roles.cache.get(settings.dailyReportRoleId);
  const mention = role ? `<@&${role.id}>` : "";

  await channel.send({
    content: [
      mention,
      `📊 **DAILY SERVER REPORT — ${reportDayKey}**`,
      "",
      `💬 **MEMBERS TEXTED:** ${stats.textedMembers}`,
      `🎙️ **MEMBERS IN VC:** ${stats.vcMembers}`,
      `💬 **TOTAL MESSAGES:** ${stats.messages.toLocaleString("en-US")}`,
      `⏱️ **TOTAL VOICE TIME:** ${formatReportDuration(stats.vcSeconds)}`,
      `👋 **NEW MEMBERS:** ${stats.newMembers}`,
      `🟢 **PEAK ONLINE:** ${stats.peakOnline}`
    ].filter(Boolean).join("\n")
  });

  await channel.send({ files: [images[0]] });
  await channel.send({ files: [images[1]] });

  markDailyReportSent(guild.id, reportDayKey);
  return true;
}

function formatReportDuration(seconds) {
  seconds = Math.round(Number(seconds) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

async function runDailyProgressReports() {
  const reportDayKey = previousDayKey();
  for (const guild of client.guilds.cache.values()) {
    try {
      await sendDailyProgressReport(guild, reportDayKey);
    } catch (err) {
      console.error(`Daily progression report error for ${guild.id}:`, err);
    }
  }
}

let lastDailyCheckKey = null;
setInterval(() => {
  const currentKey = dateKey();
  if (lastDailyCheckKey === currentKey) return;
  lastDailyCheckKey = currentKey;
  runDailyProgressReports().catch(err => console.error("Daily progression report loop error:", err));
}, 15000);

/* =========================
   BOT READY
========================= */

client.once("clientReady", async () => {
  console.log(
    `DISCORD READY: Logged in as ${client.user.tag}`
  );
  console.log(
    `DISCORD READY DETAILS: userId=${client.user.id} guilds=${client.guilds.cache.size}`
  );

  try {
    await deployCommands();

    console.log(
      "Leader is online."
    );

    restoreActiveVoiceSessions();
    restoreVoiceSessions(client);
    updatePeakOnlineForAllGuilds();
    runDailyProgressReports().catch(err => console.error("Initial daily progress report error:", err));

  } catch (err) {
    console.error(
      "Slash-command registration failed:",
      err
    );
  }
});


/* =========================
   COMMUNITY ACTIVITY SYSTEM
========================= */

const activityConfig = new Map();
const activityState = new Map();

const ACTIVITY_DEFAULTS = {
  enabled: true,
  inactivityMs: 10 * 60 * 1000,
  cooldownMs: 30 * 60 * 1000,
  tagCount: 5,
  category: "all",
  quietStart: null,
  quietEnd: null,
  channelId: null
};

// Community Activity settings are persisted per server so they do not reset
// when the bot restarts. The file is kept next to the bot's main entry file.
const ACTIVITY_CONFIG_FILE = path.join(__dirname, "activity-config.json");

function loadActivityConfigs() {
  try {
    if (!fs.existsSync(ACTIVITY_CONFIG_FILE)) return;
    const raw = fs.readFileSync(ACTIVITY_CONFIG_FILE, "utf8");
    const saved = JSON.parse(raw);

    if (!saved || typeof saved !== "object") return;

    for (const [guildId, value] of Object.entries(saved)) {
      if (!value || typeof value !== "object") continue;

      activityConfig.set(guildId, {
        ...ACTIVITY_DEFAULTS,
        ...value
      });
    }

    console.log(`Loaded community activity settings for ${activityConfig.size} server(s).`);
  } catch (err) {
    console.error("Failed to load activity settings:", err);
  }
}

function saveActivityConfigs() {
  try {
    const data = Object.fromEntries(activityConfig.entries());
    const tempFile = `${ACTIVITY_CONFIG_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    fs.renameSync(tempFile, ACTIVITY_CONFIG_FILE);
  } catch (err) {
    console.error("Failed to save activity settings:", err);
  }
}

loadActivityConfigs();

const activityQuestions = {
  gaming: [
    "Agar abhi unlimited gaming time mil jaaye, kaunsa game sabse pehle kheloge? 🎮",
    "Tumhara all-time favourite game kaunsa hai aur kyun? 👀",
    "Rank push better hai ya chill gaming? 😂",
    "Agar ek game ka developer tumhe ek feature add karne bole, kya add karoge? 🔥"
  ],
  cars: [
    "Dream car kaunsi hai? Budget ki tension nahi hai 👀🚗",
    "BMW, Audi ya Mercedes — ek choose karo. 😈",
    "Agar ₹10 lakh mil jaaye car ke liye, kya loge? 🚘",
    "Sports car ya luxury SUV? Batao apna pick 🔥"
  ],
  funny: [
    "Agar tum 24 hours invisible ho jao, sabse pehle kya karoge? 😂",
    "Phone mein sabse zyada useless app kaunsi hai? 😭",
    "Agar tumhare life ka meme banega, caption kya hoga? 😂",
    "Sabse weird cheez jo tumne kabhi online search ki hai? 👀"
  ],
  troll: [
    "Sach sach batao — tum log server mein chat karne aaye ho ya bas online dikhne? 😂",
    "Aaj kiski beizzati pending hai? Tag nahi karna, bas naam batao 😭",
    "Tumhari sabse dangerous gaming habit kya hai? 😈",
    "Agar tumhe 1 din ke liye server owner bana diya, sabse pehle kya todoge? 😂"
  ],
  "hot-takes": [
    "Hot take 🔥 — chai coffee se better hai. Agree ya fight? 😂",
    "Late-night gaming > daytime gaming? 👀",
    "Voice chat better hai ya text chat? 🔥",
    "Solo gaming ya squad — ek choose karo."
  ],
  brain: [
    "Quick brain test 🧠: 1 minute mein kitne countries ke naam yaad aa sakte hain?",
    "Aisi kaunsi cheez hai jo jitni zyada dry hoti hai, utni hi zyada wet karti hai? 👀",
    "Agar kal se time travel possible ho, past ya future? Why? 🧠"
  ],
  life: [
    "Agar life mein ek skill instantly master kar sakte ho, kya choose karoge? 👀",
    "Tumhari life ka abhi tak ka best decision kya raha?",
    "Dream destination kaunsi hai? ✈️",
    "Agar ek year ka free time mil jaaye, kya karoge?"
  ],
  friendship: [
    "Good friend ki sabse important quality kya hoti hai? ❤️",
    "Online friendship ya real-life friendship — difference kya lagta hai? 👀",
    "Dost ke saath sabse funny memory kya hai? 😂"
  ],
  music: [
    "Abhi tumhare headphones mein kaunsa song chal raha hai? 🎵",
    "One artist you can listen to all day? 👀",
    "Sad songs ya hype songs?"
  ],
  movies: [
    "Ek movie jo tum baar-baar dekh sakte ho? 🎬",
    "Movie night: comedy, action ya horror? 👀",
    "Agar kisi movie universe mein rehna ho, kaunsa choose karoge?"
  ],
  desi: [
    "Desi debate 🔥 — chai ke saath biscuit dip karna valid hai ya crime? 😂",
    "Ghar ka khana ya street food? 🍕",
    "Delhi, Mumbai ya Goa — weekend trip ke liye kya choose karoge? 🇮🇳"
  ],
  money: [
    "Agar ₹10 lakh mil jaaye aur spend karna compulsory ho, sabse pehle kya loge? 💰",
    "Money ya free time — ek choose karo. 👀",
    "Agar ek business start karna ho, kya start karoge?"
  ],
  travel: [
    "Free flight anywhere in the world — kahan jaoge? ✈️",
    "Mountains ya beach? 🏔️🏖️",
    "Dream road trip route kya hai? 🚗"
  ],
  food: [
    "Pizza ya biryani? No 'both' allowed 😂",
    "Spicy food kitna handle kar sakte ho? 🌶️",
    "Favourite street food? 👀"
  ],
  server: [
    "Agar server mein ek naya feature add kar sakte ho, kya add karoge? 👀",
    "Server ka favourite channel kaunsa hai? 😂",
    "Agar 1 day ke liye owner ban jao, sabse pehle kya change karoge? 🔥"
  ],
  random: [
    "Agar tumhe ek superpower mil jaaye, kya choose karoge? ⚡",
    "Morning person ya night owl? 🌙",
    "Ek word mein apna mood batao. 👀",
    "Aaj ka rating out of 10? 😂",
    "Agar tumhari life ek game hoti, current level kya hota? 🎮"
  ]
};

const activityStyles = [
  (mentions, q) => `👀 ${mentions}\n**CHAT DEAD ALERT** 🚨\n10 min se chat shaant hai 😂\n\n${q}`,
  (mentions, q) => `🎲 ${mentions}\n**Random question:**\n${q}`,
  (mentions, q) => `🔥 ${mentions}\n**Quick debate!**\n${q}`,
  (mentions, q) => `😈 ${mentions}\nOye tum 5 log... ek important sawaal hai 👀\n${q}`,
  (mentions, q) => `💬 ${mentions}\nChalo thodi chat revive karte hain 😂\n${q}`
];

function getActivityConfig(guildId) {
  if (!activityConfig.has(guildId)) {
    activityConfig.set(guildId, { ...ACTIVITY_DEFAULTS });
    saveActivityConfigs();
  }
  return activityConfig.get(guildId);
}

function getActivityState(guildId) {
  if (!activityState.has(guildId)) {
    activityState.set(guildId, {
      lastHumanAt: Date.now(),
      lastPromptAt: 0,
      taggedRecently: new Map(),
      pending: null
    });
  }
  return activityState.get(guildId);
}

function parseDuration(value) {
  const match = String(value || "").trim().toLowerCase().match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const multiplier = match[2] === "s" ? 1000 : match[2] === "m" ? 60000 : 3600000;
  return n * multiplier;
}

function parseHour(value) {
  const m = String(value || "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (m[3] === "pm" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function isQuietTime(config) {
  if (config.quietStart === null || config.quietEnd === null) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (config.quietStart === config.quietEnd) return true;
  if (config.quietStart < config.quietEnd) {
    return minutes >= config.quietStart && minutes < config.quietEnd;
  }
  return minutes >= config.quietStart || minutes < config.quietEnd;
}

function normalizeCategory(value) {
  const v = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (v === "all") return "all";
  if (v === "hot" || v === "hottakes" || v === "hot-take") return "hot-takes";
  if (v === "brain-teaser" || v === "brains") return "brain";
  return Object.prototype.hasOwnProperty.call(activityQuestions, v) ? v : null;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickActivityQuestion(category) {
  const pool = category === "all"
    ? Object.values(activityQuestions).flat()
    : activityQuestions[category];
  return randomItem(pool);
}

async function selectActivityMembers(channel, count, state) {
  const members = await channel.guild.members.fetch().catch(() => null);
  if (!members) return [];

  const eligible = members.filter(member => {
    if (member.user.bot) return false;
    if (!member.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) return false;
    const lastTagged = state.taggedRecently.get(member.id) || 0;
    return Date.now() - lastTagged >= 60 * 60 * 1000;
  });

  let pool = Array.from(eligible.values());

  // If the rotation pool is too small, allow older tagged users as a fallback.
  if (pool.length < count) {
    pool = Array.from(members.values()).filter(member =>
      !member.user.bot && member.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)
    );
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, Math.min(count, pool.length));
}

async function triggerActivityPrompt(channel, config, state) {
  const members = await selectActivityMembers(channel, config.tagCount, state);
  if (!members.length) return;

  const mentions = members.map(member => `<@${member.id}>`).join(" ");
  const question = pickActivityQuestion(config.category);
  const style = randomItem(activityStyles);

  const sent = await channel.send(style(mentions, question)).catch(err => {
    console.error("Activity prompt error:", err);
    return null;
  });

  if (!sent) return;

  const now = Date.now();
  for (const member of members) state.taggedRecently.set(member.id, now);
  state.lastPromptAt = now;
  state.pending = {
    messageId: sent.id,
    channelId: channel.id,
    taggedIds: new Set(members.map(member => member.id)),
    respondedIds: new Set(),
    followUpSent: false,
    createdAt: now
  };
}

async function handleActivityMessage(message) {
  const config = getActivityConfig(message.guild.id);
  const state = getActivityState(message.guild.id);

  if (message.channel.id !== config.channelId) return;

  state.lastHumanAt = Date.now();

  // A couple of tagged members replying means the conversation is alive.
  if (state.pending && !state.pending.followUpSent && state.pending.channelId === message.channel.id &&
      Date.now() - state.pending.createdAt <= 10 * 60 * 1000 && state.pending.taggedIds.has(message.author.id)) {
    state.pending.respondedIds.add(message.author.id);
    if (state.pending.respondedIds.size >= 2) {
      state.pending.followUpSent = true;
      const replies = Array.from(state.pending.respondedIds).slice(0, 2).map(id => `<@${id}>`).join(" ");
      await message.channel.send(`👀 ${replies} ne answer de diya... baaki log kaha ho? 😂`).catch(() => {});
    }
  }
}

async function runActivityLoop() {
  for (const [guildId, config] of activityConfig) {
    if (!config.enabled || !config.channelId || isQuietTime(config)) continue;
    const state = getActivityState(guildId);
    if (Date.now() - state.lastHumanAt < config.inactivityMs) continue;
    if (Date.now() - state.lastPromptAt < config.cooldownMs) continue;

    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(config.channelId);
    if (!channel || !channel.isTextBased()) continue;

    // Re-check the channel's latest message so the timer remains accurate after restarts/cache changes.
    const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    if (latest?.first() && latest.first().createdTimestamp > state.lastHumanAt) {
      state.lastHumanAt = latest.first().createdTimestamp;
      continue;
    }

    await triggerActivityPrompt(channel, config, state);
  }
}

setInterval(() => {
  runActivityLoop().catch(err => console.error("Activity loop error:", err));
}, 15000);

function activityHelp() {
  return [
    "**Community Activity Commands**",
    "`?setmainchannel #channel` — set the monitored channel",
    "`?lock` — lock the current channel (members can read only)",
    "`?unlock` — unlock the current channel",
    "`?activity on` / `?activity off` — enable/disable",
    "`?activity status` — show current settings",
    "`?activity test` — trigger a prompt now",
    "`?activity reset` — reset settings",
    "`?activity cooldown 30m` — set prompt cooldown",
    "`?activity tags 5` — set number of tagged users",
    "`?activity quiet 12am-7am` — set quiet hours",
    "`?activity quiet off` — disable quiet hours",
    "`?activity category gaming` — choose question category",
    "`?activity category all` — use all categories"
  ].join("\n");
}

async function handleActivityCommand(message) {
  const content = message.content.trim();
  const lower = content.toLowerCase();
  const manage = message.member.permissions.has(PermissionFlagsBits.ManageGuild);

  if (lower === "?lock") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply("❌ You need **Manage Channels** permission.");
    if (!message.channel.permissionOverwrites) return message.reply("❌ This channel cannot be locked.");
    try {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
      return message.channel.send("🔒 **Channel locked.** Members can read the channel, but cannot send messages.");
    } catch (err) {
      console.error("Channel lock error:", err);
      return message.reply("❌ I couldn't lock this channel. Make sure I have **Manage Channels** permission.");
    }
  }

  if (lower === "?unlock") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply("❌ You need **Manage Channels** permission.");
    if (!message.channel.permissionOverwrites) return message.reply("❌ This channel cannot be unlocked.");
    try {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
      return message.channel.send("🔓 **Channel unlocked.** Members can send messages again.");
    } catch (err) {
      console.error("Channel unlock error:", err);
      return message.reply("❌ I couldn't unlock this channel. Make sure I have **Manage Channels** permission.");
    }
  }

  if (lower.startsWith("?setmainchannel")) {
    if (!manage) return message.reply("❌ You need **Manage Server** permission.");
    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) return message.reply("❌ Use `?setmainchannel #channel`");
    const config = getActivityConfig(message.guild.id);
    config.channelId = channel.id;
    config.enabled = true;
    saveActivityConfigs();
    const state = getActivityState(message.guild.id);
    state.lastHumanAt = Date.now();
    return message.reply(`✅ Main activity channel set to ${channel}.`);
  }

  if (!lower.startsWith("?activity")) return false;
  if (!manage) return message.reply("❌ You need **Manage Server** permission.");

  const args = content.split(/\s+/).slice(1);
  const action = (args[0] || "help").toLowerCase();
  const config = getActivityConfig(message.guild.id);
  const state = getActivityState(message.guild.id);

  if (action === "help") return message.reply(activityHelp());
  if (action === "on") {
    config.enabled = true;
    state.lastHumanAt = Date.now();
    saveActivityConfigs();
    return message.reply("🟢 Community Activity is **ON**.");
  }
  if (action === "off") {
    config.enabled = false;
    saveActivityConfigs();
    return message.reply("🔴 Community Activity is **OFF**.");
  }
  if (action === "reset") {
    activityConfig.set(message.guild.id, { ...ACTIVITY_DEFAULTS });
    activityState.set(message.guild.id, { lastHumanAt: Date.now(), lastPromptAt: 0, taggedRecently: new Map(), pending: null });
    saveActivityConfigs();
    return message.reply("♻️ Activity settings reset.");
  }
  if (action === "test") {
    if (!config.channelId) return message.reply("❌ Set a main channel first with `?setmainchannel #channel`.");
    const channel = message.guild.channels.cache.get(config.channelId);
    if (!channel?.isTextBased()) return message.reply("❌ The configured channel is unavailable.");
    await triggerActivityPrompt(channel, config, state);
    return message.reply("🧪 Activity test triggered.");
  }
  if (action === "status") {
    const quiet = config.quietStart === null ? "Disabled" : `${Math.floor(config.quietStart / 60)}:${String(config.quietStart % 60).padStart(2, "0")} → ${Math.floor(config.quietEnd / 60)}:${String(config.quietEnd % 60).padStart(2, "0")}`;
    const last = state.lastHumanAt ? `<t:${Math.floor(state.lastHumanAt / 1000)}:R>` : "unknown";
    return message.reply([
      "**COMMUNITY ACTIVITY**",
      `🟢 Status: **${config.enabled ? "Enabled" : "Disabled"}**`,
      `💬 Main Channel: ${config.channelId ? `<#${config.channelId}>` : "Not set"}`,
      `⏱️ Inactivity: **${Math.round(config.inactivityMs / 60000)} minutes**`,
      `👥 Tags: **${config.tagCount}**`,
      `🔄 Cooldown: **${Math.round(config.cooldownMs / 60000)} minutes**`,
      `🧠 Category: **${config.category}**`,
      `🌙 Quiet Hours: **${quiet}**`,
      `💬 Last human message: ${last}`
    ].join("\n"));
  }
  if (action === "cooldown") {
    const ms = parseDuration(args[1]);
    if (!ms) return message.reply("❌ Example: `?activity cooldown 30m`");
    config.cooldownMs = ms;
    saveActivityConfigs();
    return message.reply(`✅ Activity cooldown set to **${args[1]}**.`);
  }
  if (action === "tags") {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n < 1 || n > 10) return message.reply("❌ Tags must be between **1 and 10**.");
    config.tagCount = n;
    saveActivityConfigs();
    return message.reply(`✅ The bot will tag **${n} users**.`);
  }
  if (action === "category") {
    const category = normalizeCategory(args[1]);
    if (!category) return message.reply(`❌ Unknown category. Use: ${Object.keys(activityQuestions).join(", ")}, or \`all\`.`);
    config.category = category;
    saveActivityConfigs();
    return message.reply(`✅ Question category set to **${category}**.`);
  }
  if (action === "quiet") {
    if ((args[1] || "").toLowerCase() === "off") {
      config.quietStart = null;
      config.quietEnd = null;
      saveActivityConfigs();
      return message.reply("🌙 Quiet hours disabled.");
    }
    const range = args[1] || "";
    const parts = range.split("-");
    const start = parseHour(parts[0]);
    const end = parseHour(parts[1]);
    if (start === null || end === null) return message.reply("❌ Example: `?activity quiet 12am-7am`");
    config.quietStart = start;
    config.quietEnd = end;
    saveActivityConfigs();
    return message.reply(`🌙 Quiet hours set to **${parts[0]}-${parts[1]}**.`);
  }
  return message.reply(activityHelp());
}

/* =========================
   MESSAGE COMMANDS
========================= */

client.on(
  "messageCreate",
  async message => {

    if (
      !message.guild ||
      message.author.bot
    ) {
      return;
    }

    const content = message.content.trim();
    const lowerContent = content.toLowerCase();
    const manageGuild = message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;

    // Send the command reference PDF by DM.
    if (["?modpdf", "?commands"].includes(lowerContent)) {
      try {
        await message.reply("Check your DM ✅");

        const commandsPdfPath = path.join(__dirname, "commands.pdf");
        if (!fs.existsSync(commandsPdfPath)) {
          console.error("commands.pdf not found:", commandsPdfPath);
          return message.author.send(
            "❌ I couldn't find the command guide PDF on the bot server."
          ).catch(() => {});
        }

        const commandsPdf = new AttachmentBuilder(commandsPdfPath, {
          name: "Leader-Commands.pdf"
        });

        await message.author.send({
          content: "📘 **Leader Bot — Command Reference**\n\nHere is the complete command guide:",
          files: [commandsPdf]
        });
      } catch (err) {
        console.error("Could not send command PDF DM:", err);
        // If the user's DMs are closed, send a helpful message in the server.
        await message.channel.send(
          `${message.author} ❌ I couldn't send you the PDF. Please enable DMs from server members and try \`?modpdf\` again.`
        ).catch(() => {});
      }
      return;
    }

    // Count every human message sent in the server, including command messages.
    recordMessageActivity(message.guild.id, message.author.id);
    recordModChatActivity(message);

    // Consecutive identical-message anti-spam: A -> A -> A warns;
    // A -> B -> A does not. Case and repeated whitespace are normalized.
    await processAntiSpam(message);

    // Media-only channels: text-only messages are removed. Attachments must be
    // images/videos. Bot commands are not treated as media.
    if (mediaOnlyChannels.has(message.channel.id) && !message.author.bot) {
      const hasMedia = message.attachments.some(a => {
        const type = String(a.contentType || "").toLowerCase();
        return type.startsWith("image/") || type.startsWith("video/");
      });
      if (!hasMedia) {
        if (message.content.trim().startsWith("?")) {
          const notice = await message.channel.send({
            content: `${message.author} ❌ This is a **media-only channel**. Commands/text messages are not allowed here.`,
            allowedMentions: { users: [message.author.id] }
          }).catch(() => null);
          await message.delete().catch(() => {});
          if (notice) setTimeout(() => notice.delete().catch(() => {}), 4000);
        } else {
          await message.delete().catch(() => {});
        }
        return;
      }
    }

    const activityCommandResult = await handleActivityCommand(message);
    if (activityCommandResult !== false) {
      return;
    }

    /* =========================
       DAILY MODERATOR ALERT COMMANDS
    ========================= */
    const alertConfigCommands = ["?setmodalert", "?setalerttime", "?setminreqvc", "?setminreqchat", "?setvcmod", "?setchatmod"];
    const alertCommand = lowerContent.split(/\s+/)[0];

    if (alertConfigCommands.includes(alertCommand)) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      if (!(await requireAlertPassword(message))) return;

      const st = getModAlertState(message.guild.id);
      const args = content.split(/\s+/);

      if (alertCommand === "?setmodalert") {
        st.channelId = message.channel.id;
        saveModAlertState();
        return message.channel.send("✅ Daily moderator alert channel configured.");
      }
      if (alertCommand === "?setalerttime") {
        const time = parseAlertTime(args[1]);
        if (!time) return message.channel.send("❌ Invalid time. Example: `?setalerttime 7:30am admin@151093`");
        st.alertTime = time;
        saveModAlertState();
        return message.channel.send(`✅ Daily moderator alert time set to **${args[1]}** (${MOD_ALERT_TIME_ZONE}).`);
      }
      if (alertCommand === "?setminreqvc") {
        const seconds = parseVcRequirement(args[1]);
        if (!seconds || seconds < 60) return message.channel.send("❌ Invalid VC requirement. Example: `?setminreqvc 3h admin@151093` or `2:30h`.");
        st.minVcSeconds = seconds;
        saveModAlertState();
        return message.channel.send(`✅ Daily VC moderator requirement set to **${formatDurationShort(seconds)}**.`);
      }
      if (alertCommand === "?setminreqchat") {
        const count = Number(args[1]);
        if (!Number.isInteger(count) || count < 1) return message.channel.send("❌ Invalid message requirement. Example: `?setminreqchat 300 admin@151093`.");
        st.minChatMessages = count;
        saveModAlertState();
        return message.channel.send(`✅ Daily Chat moderator requirement set to **${count} messages**.`);
      }
      if (alertCommand === "?setvcmod") {
        const role = message.mentions.roles.first();
        if (!role) return message.channel.send("❌ Use `?setvcmod @role admin@151093`.");
        st.vcRoleId = role.id;
        saveModAlertState();
        return message.channel.send(`✅ VC moderator role configured as ${role}.`);
      }
      if (alertCommand === "?setchatmod") {
        const role = message.mentions.roles.first();
        if (!role) return message.channel.send("❌ Use `?setchatmod @role admin@151093`.");
        st.chatRoleId = role.id;
        saveModAlertState();
        return message.channel.send(`✅ Chat moderator role configured as ${role}.`);
      }
    }

    if (lowerContent === "?modalertstatus") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const st = getModAlertState(message.guild.id);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("🛡️ Moderator Alert Status")
          .setColor(0x5865F2)
          .addFields(
            { name: "Alert channel", value: st.channelId ? `<#${st.channelId}>` : "Not configured", inline: true },
            { name: "Alert time", value: `${st.alertTime || "Not configured"} (${MOD_ALERT_TIME_ZONE})`, inline: true },
            { name: "VC role", value: st.vcRoleId ? `<@&${st.vcRoleId}>` : "Not configured", inline: true },
            { name: "Chat role", value: st.chatRoleId ? `<@&${st.chatRoleId}>` : "Not configured", inline: true },
            { name: "VC minimum", value: formatDurationShort(st.minVcSeconds), inline: true },
            { name: "Chat minimum", value: `${st.minChatMessages} messages`, inline: true }
          ).setTimestamp()]
      });
    }

    if (lowerContent === "?modalerttest") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const sent = await sendDailyModAlert(message.guild, true);
      return message.reply(sent ? "✅ Moderator alert test sent." : "❌ Configure `?setmodalert` first.");
    }

    if (lowerContent === "?resetalert") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const st = getModAlertState(message.guild.id);
      st.lastAlertDate = null;
      saveModAlertState();
      return message.reply(`✅ Today's moderator-alert sent status was reset. Scheduled alert remains **${st.alertTime}** (${MOD_ALERT_TIME_ZONE}).`);
    }

    /* =========================
       AUTOMATIC NEW-MEMBER ROLES
    ========================= */
    if (lowerContent.startsWith("?setautorole") || lowerContent === "?autoroles" ||
        lowerContent.startsWith("?removeautorole") || lowerContent === "?clearautoroles") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");

      const guildId = message.guild.id;
      const current = getAutoRoleIds(guildId);

      if (lowerContent === "?autoroles") {
        const valid = current.map(id => message.guild.roles.cache.get(id)).filter(Boolean);
        return message.reply(valid.length
          ? `🤖 **Automatic New-Member Roles**\n${valid.map(r => `• ${r}`).join("\n")}`
          : "ℹ️ No automatic roles are configured.");
      }

      if (lowerContent === "?clearautoroles") {
        delete autoRoleConfig[guildId];
        saveAutoRoles();
        return message.reply("✅ All automatic new-member roles have been cleared.");
      }

      const roles = message.mentions.roles.filter(role => role.id !== guildId);
      if (!roles.size) {
        return message.reply("❌ Use `?setautorole @role1 @role2 @role3`.");
      }

      if (lowerContent.startsWith("?removeautorole")) {
        const removeIds = new Set(roles.map(r => r.id));
        const next = current.filter(id => !removeIds.has(id));
        autoRoleConfig[guildId] = next;
        saveAutoRoles();
        return message.reply(`✅ Removed automatic role(s): ${roles.map(r => `${r}`).join(" ")}`);
      }

      const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
      const unassignable = roles.filter(role => botMember && (role.managed || role.position >= botMember.roles.highest.position));
      if (unassignable.size) {
        return message.reply(`❌ I cannot automatically give ${unassignable.map(r => `${r}`).join(" ")}. Move those roles below my highest role and try again.`);
      }

      const next = [...new Set([...current, ...roles.map(r => r.id)])];
      autoRoleConfig[guildId] = next;
      saveAutoRoles();
      return message.reply(`✅ New members will automatically receive: ${formatRoleMentions(message.guild, next)}\nUse \`?autoroles\` to view them.`);
    }

    /* =========================
       MODERATION LOG CONFIG
    ========================= */
    if (lowerContent === "?modlogs" || lowerContent.startsWith("?setmodlogs") ||
        lowerContent.startsWith("?setmessagelog") || lowerContent === "?messagelog" ||
        lowerContent.startsWith("?setvoicelog") || lowerContent === "?voicelog" ||
        lowerContent.startsWith("?setchannellog") || lowerContent === "?channellog" ||
        lowerContent.startsWith("?setrolelog") || lowerContent === "?rolelog" ||
        lowerContent.startsWith("?setmemberlog") || lowerContent === "?memberlog") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");

      const settings = moderationLogConfig[message.guild.id] || (moderationLogConfig[message.guild.id] = {});
      const save = () => saveJson(MODLOG_CONFIG_FILE, moderationLogConfig);

      if (lowerContent === "?modlogs") {
        const labels = [
          ["mod", "🛡️ Moderation", "Moderation actions"],
          ["message", "💬 Messages", "Message edits/deletions"],
          ["voice", "🔊 Voice", "Voice joins/leaves/changes"],
          ["channel", "📺 Channels", "Channel changes"],
          ["role", "🎭 Roles", "Role creation/deletion/updates"],
          ["member", "👤 Members", "Member joins/leaves/profile/role changes"]
        ];
        const lines = labels.map(([key, label, desc]) =>
          `${label}: ${settings[key] ? `<#${settings[key]}>` : "Not configured"} — ${desc}`
        );
        return message.reply({
          embeds: [new EmbedBuilder()
            .setTitle("🛡️ Leader • Moderation Log Configuration")
            .setColor(0x5865F2)
            .setDescription(lines.join("\n"))
            .setFooter({ text: "Use the set...log commands to configure each category." })
            .setTimestamp()]
        });
      }

      const command = lowerContent.split(/\s+/)[0];
      const category = command === "?setmodlogs" ? "mod" :
        command === "?setmessagelog" ? "message" :
        command === "?setvoicelog" ? "voice" :
        command === "?setchannellog" ? "channel" :
        command === "?setrolelog" ? "role" :
        command === "?setmemberlog" ? "member" : null;

      if (!category) {
        const current = settings[command === "?messagelog" ? "message" : command === "?voicelog" ? "voice" : command === "?channellog" ? "channel" : command === "?memberlog" ? "member" : "role"];
        return message.reply(current ? `📋 Log channel: <#${current}>` : "📋 That log category is not configured.");
      }

      const channel = message.mentions.channels.first();
      if (!channel?.isTextBased()) {
        const examples = {
          mod: "?setmodlogs #mod-logs",
          message: "?setmessagelog #messages-log",
          voice: "?setvoicelog #voice-log",
          channel: "?setchannellog #channel-log",
          role: "?setrolelog #role-log",
          member: "?setmemberlog #member-log"
        };
        return message.reply(`❌ Use \`${examples[category]}\`.`);
      }

      settings[category] = channel.id;
      save();
      const names = { mod: "Moderation", message: "Message", voice: "Voice", channel: "Channel", role: "Role", member: "Member" };
      return message.reply(`✅ **${names[category]} logs** are now configured for ${channel}.`);
    }

    /* =========================
       MEDIA-ONLY CHANNEL
    ========================= */
    if (lowerContent === "?setmedia") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      mediaOnlyChannels.add(message.channel.id);
      saveJson(MEDIA_ONLY_FILE, Object.fromEntries([...mediaOnlyChannels].map(id => [id, true])));
      await message.channel.send("📸 **Media-only mode enabled.** Only images and videos are allowed in this channel.");
      return;
    }

    if (lowerContent === "?removemedia") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      mediaOnlyChannels.delete(message.channel.id);
      saveJson(MEDIA_ONLY_FILE, Object.fromEntries([...mediaOnlyChannels].map(id => [id, true])));
      return message.reply("✅ Media-only mode disabled for this channel.");
    }

    /* =========================
       CHANNEL SHORTCUTS
       ?setas chat -> current channel
       ?m chat inside any message -> channel mention
    ========================= */

    if (lowerContent.startsWith("?setdailyreportrole")) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const role = message.mentions.roles.first();
      if (!role) return message.reply("❌ Use `?setdailyreportrole @role`");
      setDailyReportRole(message.guild.id, role.id);
      return message.reply(`✅ Daily report role set to ${role}.`);
    }

    if (lowerContent === "?setasprogressviewchannel") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      if (!message.channel.isTextBased()) return message.reply("❌ This channel cannot be used.");
      setProgressViewChannel(message.guild.id, message.channel.id);
      return message.reply(`✅ Daily progression reports will be sent in ${message.channel}.`);
    }

    // Server-wide progression graphs. No individual-user statistics are shown.
    if (lowerContent === "?progress" || /^\?progress\s+\d+$/.test(lowerContent)) {
      const parts = content.split(/\s+/);
      let days = Number(parts[1] || 7);
      if (!Number.isInteger(days) || days < 2) days = 7;
      days = Math.min(days, 30);

      try {
        const stats = getDayStats(message.guild.id);
        const images = await getProgressionImages(message.guild.id, days);
        await message.channel.send({
          content: [
            `📊 **TODAY'S SERVER PROGRESS REPORT — ${stats.key}**`,
            "",
            `💬 **MEMBERS TEXTED:** ${stats.textedMembers}`,
            `🎙️ **MEMBERS IN VC:** ${stats.vcMembers}`,
            `💬 **TOTAL MESSAGES:** ${stats.messages.toLocaleString("en-US")}`,
            `⏱️ **TOTAL VOICE TIME:** ${formatReportDuration(stats.vcSeconds)}`,
            `👋 **NEW MEMBERS:** ${stats.newMembers}`,
            `🟢 **PEAK ONLINE:** ${stats.peakOnline}`
          ].join("\n")
        });
        await message.channel.send({ files: [images[0]] });
        await message.channel.send({ files: [images[1]] });
      } catch (err) {
        console.error("Progression graph error:", err);
        await message.reply("❌ I couldn't generate the progression graphs. Check the bot logs.");
      }
      return;
    }

    if (lowerContent.startsWith("?setas")) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");

      const args = content.split(/\s+/);
      const name = shortcutName(args[1]);

      if (!name) {
        return message.reply("❌ Use `?setas chat` to save the current channel as a shortcut.");
      }

      if (name === "m") {
        return message.reply("❌ `m` is reserved for channel shortcuts. Choose another shortcut name.");
      }

      if (!message.channel.isTextBased()) {
        return message.reply("❌ This channel cannot be used as a shortcut.");
      }

      if (!channelShortcuts[message.guild.id]) channelShortcuts[message.guild.id] = {};
      channelShortcuts[message.guild.id][name] = message.channel.id;
      saveChannelShortcuts();

      return message.reply(`✅ Shortcut **${name}** saved for this channel.`);
    }

    if (lowerContent.startsWith("?removeas")) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");

      const args = content.split(/\s+/);
      const name = shortcutName(args[1]);
      const guildShortcuts = channelShortcuts[message.guild.id] || {};

      if (!name) return message.reply("❌ Use `?removeas chat`.");
      if (!guildShortcuts[name]) return message.reply("❌ That shortcut is not set.");

      delete guildShortcuts[name];
      saveChannelShortcuts();
      return message.reply(`✅ Shortcut **${name}** removed.`);
    }

    if (lowerContent === "?listas") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");

      const guildShortcuts = channelShortcuts[message.guild.id] || {};
      const entries = Object.entries(guildShortcuts);
      if (!entries.length) return message.reply("ℹ️ No channel shortcuts are set.");

      return message.reply(entries.map(([name, channelId]) => `• **${name}** → <#${channelId}>`).join("\n"));
    }

    // ?m <shortcut> can appear anywhere inside a message.
    // Example: "I AM GOING TO ?m chat" -> "I AM GOING TO #chat".
    // Discord bots cannot edit another user's message, so the original message
    // is left untouched and the bot sends the expanded version as a new message.
    if (/\?m\s+[a-zA-Z0-9_-]+/i.test(content)) {
      loadChannelShortcuts();

      const guildShortcuts = channelShortcuts[message.guild.id] || {};
      let changed = false;
      let missingName = null;

      const expanded = content.replace(/\?m\s+([a-zA-Z0-9_-]+)/gi, (full, rawName) => {
        const name = shortcutName(rawName);
        const channelId = guildShortcuts[name];

        if (!channelId) {
          missingName = name;
          return full;
        }

        changed = true;
        return `<#${channelId}>`;
      });

      if (missingName && !changed) {
        return message.reply(`❌ Shortcut **${missingName}** is not set. Use \`?setas ${missingName}\` first.`);
      }

      if (changed) {
        try {
          await message.channel.send({
            content: expanded
          });
        } catch (err) {
          console.error("Channel shortcut expansion error:", err);
          return message.reply("❌ I couldn't send the expanded message. Check my **View Channel** and **Send Messages** permissions.");
        }

        return;
      }
    }

    await handleActivityMessage(message);

    /* =========================
       MESSAGE TRACKING
    ========================= */

    addMessage(
      message.author.id,
      message.guild.id,
      1
    );


    /* =========================
       MODERATION COMMANDS
       ?kick @user [reason]
       ?ban @user [reason]
       ?unban <userId> [reason]
       ?timeout @user <duration> [reason]
       ?untimeout @user
       ?clear / ?purge <1-100>
       ?slowmode <seconds>
       ?lock / ?unlock
    ========================= */

    const moderationTarget = () => message.mentions.members.first() || null;
    const botMember = message.guild.members.me;

    function canModerateTarget(target, actionName) {
      if (!target) return `❌ Please mention a user.`;
      if (target.id === message.author.id) return `❌ You cannot ${actionName} yourself.`;
      if (target.id === message.guild.ownerId) return `❌ You cannot ${actionName} the server owner.`;
      if (target.id === botMember?.id) return `❌ You cannot ${actionName} me.`;
      if (botMember && target.roles.highest.position >= botMember.roles.highest.position) {
        return `❌ I cannot ${actionName} that user because their highest role is above or equal to mine.`;
      }
      return null;
    }

    function parseDuration(input) {
      const match = String(input || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
      if (!match) return null;
      const value = Number(match[1]);
      const unit = match[2];
      const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
      const ms = value * multiplier;
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return ms;
    }

    if (lowerContent.startsWith("?kick")) {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply("❌ You don't have permission to kick members.");
      const target = moderationTarget();
      const hierarchyError = canModerateTarget(target, "kick");
      if (hierarchyError) return message.reply(hierarchyError);
      const reason = message.content.split(/\s+/).slice(2).join(" ") || "No reason provided";
      try {
        await target.kick(reason.slice(0, 512));
        await sendModerationLog(message.guild, "kick", { user: `${target}`, moderator: `${message.member}`, reason });
        return message.reply(`👢 ${target.user.tag} has been kicked.`);
      } catch (err) {
        console.error("Kick error:", err);
        return message.reply("❌ I couldn't kick that user. Check my **Kick Members** permission and role hierarchy.");
      }
    }

    if (lowerContent.startsWith("?ban")) {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply("❌ You don't have permission to ban members.");
      const target = moderationTarget();
      const hierarchyError = canModerateTarget(target, "ban");
      if (hierarchyError) return message.reply(hierarchyError);
      const reason = message.content.split(/\s+/).slice(2).join(" ") || "No reason provided";
      try {
        await target.ban({ reason: reason.slice(0, 512), deleteMessageSeconds: 0 });
        await sendModerationLog(message.guild, "ban", { user: `${target}`, moderator: `${message.member}`, reason });
        return message.reply(`🔨 ${target.user.tag} has been banned.`);
      } catch (err) {
        console.error("Ban error:", err);
        return message.reply("❌ I couldn't ban that user. Check my **Ban Members** permission and role hierarchy.");
      }
    }

    if (lowerContent.startsWith("?unban")) {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply("❌ You don't have permission to unban members.");
      const args = message.content.trim().split(/\s+/);
      const userId = args[1];
      if (!/^\d{15,25}$/.test(userId || "")) return message.reply("❌ Use `?unban <userID> [reason]`.");
      const reason = args.slice(2).join(" ") || "No reason provided";
      try {
        await message.guild.members.unban(userId, reason.slice(0, 512));
        await sendModerationLog(message.guild, "unban", { user: `<@${userId}>`, moderator: `${message.member}`, reason });
        return message.reply(`🔓 <@${userId}> has been unbanned.`);
      } catch (err) {
        console.error("Unban error:", err);
        return message.reply("❌ I couldn't unban that user. Check the ID and my **Ban Members** permission.");
      }
    }

    if (lowerContent.startsWith("?timeout") || lowerContent.startsWith("?mute")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to timeout/mute members.");
      const target = moderationTarget();
      const hierarchyError = canModerateTarget(target, "timeout");
      if (hierarchyError) return message.reply(hierarchyError);
      const args = message.content.trim().split(/\s+/);
      const durationToken = args[2];
      const ms = parseDuration(durationToken);
      if (!ms) return message.reply("❌ Use a valid duration such as `30s`, `5m`, `2h`, or `1d`.");
      if (ms > 28 * 24 * 60 * 60 * 1000) return message.reply("❌ Discord allows a maximum timeout of 28 days.");
      const reason = args.slice(3).join(" ") || "No reason provided";
      try {
        await target.timeout(ms, reason.slice(0, 512));
        await sendModerationLog(message.guild, "timeout", { user: `${target}`, moderator: `${message.member}`, reason, details: `Duration: **${durationToken}**` });
        return message.reply(`🔇 ${target.user.tag} has been timed out for **${durationToken}**.`);
      } catch (err) {
        console.error("Timeout error:", err);
        return message.reply("❌ I couldn't timeout that user. Check my **Moderate Members** permission and role hierarchy.");
      }
    }

    if (lowerContent.startsWith("?untimeout") || lowerContent.startsWith("?unmute")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to remove timeouts.");
      const target = moderationTarget();
      const hierarchyError = canModerateTarget(target, "unmute");
      if (hierarchyError) return message.reply(hierarchyError);
      if (!target.isCommunicationDisabled()) return message.reply("ℹ️ That user is not currently timed out/muted.");
      try {
        await target.timeout(null, "Timeout removed by moderator");
        await sendModerationLog(message.guild, "unmute", { user: `${target}`, moderator: `${message.member}`, action: "Timeout removed" });
        return message.reply(`🔊 ${target.user.tag} has been unmuted.`);
      } catch (err) {
        console.error("Unmute error:", err);
        return message.reply("❌ I couldn't unmute that user. Check my **Moderate Members** permission and role hierarchy.");
      }
    }

    if (lowerContent.startsWith("?slowmode")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply("❌ You don't have permission to manage this channel.");
      const seconds = Number(message.content.trim().split(/\s+/)[1]);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) return message.reply("❌ Use `?slowmode <0-21600>` seconds.");
      if (!message.channel.isTextBased() || typeof message.channel.setRateLimitPerUser !== "function") return message.reply("❌ This channel doesn't support slowmode.");
      try {
        await message.channel.setRateLimitPerUser(seconds, `Slowmode changed by ${message.author.tag}`);
        return message.reply(`🐌 Slowmode set to **${seconds}s**.`);
      } catch (err) {
        console.error("Slowmode error:", err);
        return message.reply("❌ I couldn't change slowmode. Check my **Manage Channels** permission.");
      }
    }

    if (lowerContent === "?lock" || lowerContent === "?unlock") {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply("❌ You don't have permission to manage this channel.");
      if (!message.channel.isTextBased() || !message.channel.permissionOverwrites?.edit) return message.reply("❌ This channel cannot be locked/unlocked.");
      const everyone = message.guild.roles.everyone;
      try {
        if (lowerContent === "?lock") {
          await message.channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: `Locked by ${message.author.tag}` });
          await sendModerationLog(message.guild, "channel", { channel: `${message.channel}`, moderator: `${message.member}`, action: "Locked" });
          return message.reply("🔒 Channel locked. Members cannot send messages here.");
        }
        await message.channel.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: `Unlocked by ${message.author.tag}` });
        await sendModerationLog(message.guild, "channel", { channel: `${message.channel}`, moderator: `${message.member}`, action: "Unlocked" });
        return message.reply("🔓 Channel unlocked.");
      } catch (err) {
        console.error("Channel lock error:", err);
        return message.reply("❌ I couldn't change the channel lock. Check my **Manage Channels** permission.");
      }
    }

    /* =========================
       PURGE COMMAND
       ?purge 10
    ========================= */

    if (
      lowerContent.startsWith("?purge") ||
      lowerContent.startsWith("?clear")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ManageMessages
        )
      ) {
        return message.reply(
          "❌ You don't have permission to delete messages."
        );
      }

      const args =
        message.content.trim().split(/\s+/);

      const amount =
        parseInt(args[1], 10);

      if (
        Number.isNaN(amount) ||
        amount < 1 ||
        amount > 100
      ) {
        return message.reply(
          "❌ Usage: `?purge <1-100>` or `?clear <1-100>`"
        );
      }

      try {

        const deleted =
          await message.channel.bulkDelete(
            amount,
            true
          );

        await sendModerationLog(message.guild, "purge", {
          channel: `${message.channel}`,
          moderator: `${message.member}`,
          action: `Purged ${deleted.size} message(s)`,
          details: `Requested amount: **${amount}**`
        });

        await message.delete()
          .catch(() => {});

        const confirmation =
          await message.channel.send(
            `🧹 Successfully deleted **${deleted.size}** messages.`
          );

        setTimeout(() => {
          confirmation
            .delete()
            .catch(() => {});
        }, 3000);

      } catch (err) {

        console.error(
          "Purge error:",
          err
        );

        return message.channel.send(
          "❌ I couldn't delete those messages. Make sure I have **Manage Messages** permission and the messages are eligible for bulk deletion."
        );
      }

      return;
    }

    /* =========================
       WARN / UNWARN / WARNS
    ========================= */
    if (lowerContent === "?warns" || lowerContent.startsWith("?warns ")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to view warnings.");
      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Use `?warns @user`.");
      const list = getWarnings(message.guild.id, target.id);
      if (!list.length) return message.reply(`✅ **${target.user.tag}** has no warnings in the last 24 hours.`);
      const desc = list.map((w, i) => `**#${i + 1}** • Case \`${w.caseId}\` • <t:${Math.floor(w.timestamp / 1000)}:R>\n${w.automatic ? "🤖 Automatic" : "🛡️ Moderator"} • ${w.reason}`).join("\n\n");
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`⚠️ Warnings • ${target.user.tag}`).setColor(0xF39C12).setDescription(desc.slice(0, 4096)).setFooter({ text: `Leader • ${list.length} warning(s) in the last 24 hours` })] });
    }

    if (lowerContent.startsWith("?warn ") || lowerContent === "?warn") {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to warn members.");
      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Use `?warn @user [reason]`.");
      const reason = message.content.split(/\s+/).slice(2).join(" ") || "No reason provided";
      const entry = await issueWarning(message.guild, target, message.member, reason, false);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("⚠️ Warning Issued").setColor(0xF39C12).setDescription(`${target} has received a warning.`).addFields({ name: "Reason", value: reason }, { name: "Case ID", value: `\`${entry.caseId}\``, inline: true }, { name: "Daily Warnings", value: `${getWarnings(message.guild.id, target.id).length}/3`, inline: true }).setTimestamp()] });
    }

    if (lowerContent.startsWith("?unwarn")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to remove warnings.");
      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Use `?unwarn @user`.");
      const removed = removeLatestWarning(message.guild.id, target.id);
      if (!removed) return message.reply("ℹ️ That member has no warnings in the last 24 hours.");
      await sendModerationLog(message.guild, "unwarning", { user: `${target}`, moderator: `${message.member}`, reason: removed.reason, caseId: removed.caseId });
      return message.channel.send(`✅ Removed warning case \`${removed.caseId}\` from ${target}.`);
    }

    /* =========================
       SET NICKNAME
    ========================= */

    if (
      lowerContent.startsWith("?setnick")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ManageNicknames
        )
      ) {
        return message.reply(
          "❌ You don't have permission to change nicknames."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention the user."
        );
      }

      const nickname =
        message.content
          .split(" ")
          .slice(2)
          .join(" ");

      if (!nickname) {
        return message.reply(
          "❌ Please provide a nickname."
        );
      }

      try {

        await target.setNickname(
          nickname
        );

        return message.channel.send(
          `✅ Changed ${target}'s nickname to **${nickname}**`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't change that user's nickname. Check my role position and permissions."
        );
      }
    }

    /* =========================
       ROLE COMMANDS
    ========================= */

    if (lowerContent.startsWith("?giverole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      // The role can be mentioned in the command so Discord resolves it
      // automatically. The bot NEVER mentions the role in its own messages.
      const role = message.mentions.roles.first() || (() => {
        const roleInput = message.content
          .replace(/^\?giverole\s+/i, "")
          .replace(target ? target.toString() : "", "")
          .trim();
        return message.guild.roles.cache.find(
          r => r.id === roleInput || r.name.toLowerCase() === roleInput.toLowerCase()
        );
      })();

      if (!target) {
        return message.reply("❌ Please mention the user.");
      }

      if (!role) {
        return message.reply("❌ Role not found. Mention the role or enter its exact name/ID.");
      }

      if (role.managed) {
        return message.reply("❌ I can't manage this role.");
      }

      if (role.position >= message.guild.members.me.roles.highest.position) {
        return message.reply("❌ I can't manage this role because it is above or equal to my highest role.");
      }

      try {
        await target.roles.add(role);

        return message.channel.send({
          content: `✅ Added **${role.name}** to **${target.displayName}**.`,
          allowedMentions: { parse: [] }
        });
      } catch (err) {
        console.error("Give role error:", err);

        return message.reply({
          content: "❌ I couldn't give that role. Check my permissions and role position.",
          allowedMentions: { parse: [] }
        });
      }
    }

    if (lowerContent.startsWith("?removerole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      // The role can be mentioned in the command so Discord resolves it
      // automatically. The bot NEVER mentions the role in its own messages.
      const role = message.mentions.roles.first() || (() => {
        const roleInput = message.content
          .replace(/^\?removerole\s+/i, "")
          .replace(target ? target.toString() : "", "")
          .trim();
        return message.guild.roles.cache.find(
          r => r.id === roleInput || r.name.toLowerCase() === roleInput.toLowerCase()
        );
      })();

      if (!target) {
        return message.reply("❌ Please mention the user.");
      }

      if (!role) {
        return message.reply("❌ Role not found. Mention the role or enter its exact name/ID.");
      }

      if (role.managed) {
        return message.reply("❌ I can't manage this role.");
      }

      if (role.position >= message.guild.members.me.roles.highest.position) {
        return message.reply("❌ I can't manage this role because it is above or equal to my highest role.");
      }

      try {
        await target.roles.remove(role);

        return message.channel.send({
          content: `✅ Removed **${role.name}** from **${target.displayName}**.`,
          allowedMentions: { parse: [] }
        });
      } catch (err) {
        console.error("Remove role error:", err);

        return message.reply({
          content: "❌ I couldn't remove that role. Check my permissions and role position.",
          allowedMentions: { parse: [] }
        });
      }
    }

    /* =========================
       MUTE
    ========================= */

    if (
      lowerContent.startsWith("?mute")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to mute members."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      const duration =
        message.content
          .split(" ")[2];

      if (!duration) {
        return message.reply(
          "❌ Please provide a duration (60s, 5m, 4h, 2d)."
        );
      }

      let ms = 0;

      if (duration.endsWith("s")) {
        ms =
          parseInt(duration) *
          1000;

      } else if (duration.endsWith("m")) {
        ms =
          parseInt(duration) *
          60 *
          1000;

      } else if (duration.endsWith("h")) {
        ms =
          parseInt(duration) *
          60 *
          60 *
          1000;

      } else if (duration.endsWith("d")) {
        ms =
          parseInt(duration) *
          24 *
          60 *
          60 *
          1000;

      } else {

        return message.reply(
          "❌ Invalid duration. Use s, m, h, or d."
        );
      }

      if (!Number.isFinite(ms) || ms <= 0) {
        return message.reply(
          "❌ Invalid duration."
        );
      }

      try {

        await target.timeout(ms);

        return message.channel.send(
          `🔇 ${target} has been muted for ${duration}.`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't mute that user. Check my permissions and role position."
        );
      }
    }

    /* =========================
       UNMUTE
    ========================= */

    if (
      lowerContent.startsWith("?unmute")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to unmute members."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      if (
        !target.isCommunicationDisabled()
      ) {
        return message.reply(
          "❌ That user is not muted."
        );
      }

      try {

        await target.timeout(null);

        return message.channel.send(
          `🔊 ${target} has been unmuted.`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't unmute that user."
        );
      }
    }

    /* =========================
       ADD INSTAGRAM
    ========================= */

    if (
      lowerContent.startsWith("?addinsta")
    ) {

      const username =
        message.content
          .split(" ")[1];

      if (!username) {
        return message.reply(
          "❌ Please provide an Instagram username."
        );
      }

      setInstagram(
        message.author.id,
        message.guild.id,
        username
      );

      const role =
        message.guild.roles.cache.find(
          r =>
            r.name === "Instagram user"
        );

      if (role) {
        await message.member.roles
          .add(role)
          .catch(err =>
            console.error(
              "Instagram role add error:",
              err
            )
          );
      }

      return message.reply(
        `✅ Instagram username set to ${username}`
      );
    }

    /* =========================
       REMOVE INSTAGRAM
    ========================= */

    if (
      lowerContent.startsWith("?removeinsta")
    ) {

      removeInstagram(
        message.author.id,
        message.guild.id
      );

      const role =
        message.guild.roles.cache.find(
          r =>
            r.name === "Instagram user"
        );

      if (!role) {
        return message.reply(
          "❌ Role 'Instagram user' not found."
        );
      }

      try {

        await message.member.roles
          .remove(role);

      } catch (err) {

        console.error(err);

        return message.reply(
          `❌ Role error: ${err.message}`
        );
      }

      return message.reply(
        "✅ Instagram username removed."
      );
    }

    /* =========================
       VIEW INSTAGRAM
    ========================= */

    if (
      lowerContent.startsWith("?insta")
    ) {

      const target =
        message.mentions.users.first() ||
        message.author;

      const user =
        getUser(
          target.id,
          message.guild.id
        );

      if (!user.instagram) {
        return message.reply(
          "❌ No Instagram username set."
        );
      }

      return message.channel.send(
        `📸 ${target.username}'s Instagram:\nhttps://instagram.com/${user.instagram}`
      );
    }
  }
);

/* =========================
   AUTOMATIC MODERATION AUDIT LOGS
========================= */

client.on("messageDelete", async message => {
  if (!message.guild || message.author?.bot) return;
  const executor = await auditExecutor(message.guild, 72, message.author?.id);
  await sendModerationLog(message.guild, "messageDelete", {
    user: message.author ? `${message.author}` : "Unknown user",
    channel: `${message.channel}`,
    moderator: executor ? `${executor}` : "Unknown / self-delete",
    content: message.content || "[content unavailable]"
  });
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  const before = oldMessage.content || "[content unavailable]";
  const after = newMessage.content || "[content unavailable]";
  if (before === after) return;
  await sendModerationLog(newMessage.guild, "messageEdit", { user: `${newMessage.author}`, channel: `${newMessage.channel}`, before, after });
});

client.on("guildBanAdd", async ban => {
  const executor = await auditExecutor(ban.guild, 22, ban.user.id);
  await sendModerationLog(ban.guild, "ban", { user: `${ban.user}`, moderator: executor ? `${executor}` : "Unknown", reason: "See Discord audit log for details" });
});

client.on("guildBanRemove", async ban => {
  const executor = await auditExecutor(ban.guild, 23, ban.user.id);
  await sendModerationLog(ban.guild, "unban", { user: `${ban.user}`, moderator: executor ? `${executor}` : "Unknown" });
});

client.on("channelCreate", async channel => {
  if (!channel.guild) return;
  await sendModerationLog(channel.guild, "channel", { channel: `${channel}`, action: "Created" });
});

client.on("channelDelete", async channel => {
  if (!channel.guild) return;
  await sendModerationLog(channel.guild, "channel", { channel: `#${channel.name || channel.id}`, action: "Deleted" });
});

client.on("roleCreate", async role => {
  await sendModerationLog(role.guild, "role", { action: `Created: ${role.name}`, details: `Role: <@&${role.id}>` });
});

client.on("roleDelete", async role => {
  await sendModerationLog(role.guild, "role", { action: `Deleted: ${role.name}` });
});

client.on("guildMemberAdd", async member => {
  if (member.user?.bot) return;
  await sendModerationLog(member.guild, "memberJoin", { user: `${member}`, details: `Account: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` });

  // Automatically assign the configured pre-roles to new members.
  const roleIds = getAutoRoleIds(member.guild.id);
  if (!roleIds.length) return;

  const roles = roleIds.map(id => member.guild.roles.cache.get(id)).filter(Boolean);
  const botMember = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
  const assignable = roles.filter(role => !role.managed && botMember && role.position < botMember.roles.highest.position);
  if (!assignable.length) return;

  const key = `${member.guild.id}:${member.id}`;
  pendingAutoRoleAssignments.set(key, true);
  try {
    await member.roles.add(assignable, "Automatic new-member roles");
    // The gateway guildMemberUpdate normally produces the grouped role log.
    // If it has not arrived yet, leave the pending marker briefly; it is consumed by that event.
    setTimeout(() => pendingAutoRoleAssignments.delete(key), 10000);
  } catch (err) {
    pendingAutoRoleAssignments.delete(key);
    console.error(`Automatic role assignment failed for ${member.user.tag}:`, err);
  }
});

client.on("guildMemberRemove", async member => {
  if (member.user?.bot) return;
  const executor = await auditExecutor(member.guild, 20, member.id);
  await sendModerationLog(member.guild, "memberLeave", { user: `${member}`, moderator: executor ? `${executor}` : "Unknown / Left voluntarily" });
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (oldMember.nickname !== newMember.nickname) {
    const executor = await auditExecutor(newMember.guild, 24, newMember.id);
    await sendModerationLog(newMember.guild, "memberUpdate", {
      user: `${newMember}`,
      action: "Nickname changed",
      moderator: executor ? `${executor}` : "Unknown",
      before: oldMember.nickname || "None",
      after: newMember.nickname || "None"
    });
  }

  // Role changes belong in the ROLE log, not the MEMBER log.
  // Multiple roles changed by one action are intentionally grouped into ONE embed.
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
  if (!addedRoles.size && !removedRoles.size) return;

  const key = `${newMember.guild.id}:${newMember.id}`;
  const pendingAuto = pendingAutoRoleAssignments.get(key);
  const executor = pendingAuto ? null : await auditExecutor(newMember.guild, 25, newMember.id);
  const moderator = pendingAuto ? "Leader (Automatic Role)" : (executor ? `${executor}` : "Unknown");
  const addedText = addedRoles.size ? `**Added:** ${Array.from(addedRoles.values()).map(r => `<@&${r.id}>`).join(" ")}` : "";
  const removedText = removedRoles.size ? `**Removed:** ${Array.from(removedRoles.values()).map(r => `<@&${r.id}>`).join(" ")}` : "";
  const details = [addedText, removedText].filter(Boolean).join("\n");

  await sendModerationLog(newMember.guild, "role", {
    user: `${newMember}`,
    moderator,
    action: addedRoles.size && removedRoles.size ? "Roles updated" : addedRoles.size ? "Roles added" : "Roles removed",
    details
  });

  if (pendingAuto) {
    pendingAutoRoleAssignments.delete(key);
  }
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  const changes = [];
  if (oldChannel.name !== newChannel.name) changes.push(`Name: **${oldChannel.name}** → **${newChannel.name}**`);
  if (oldChannel.parentId !== newChannel.parentId) changes.push("Category changed");
  if (oldChannel.type !== newChannel.type) changes.push(`Type: **${oldChannel.type}** → **${newChannel.type}**`);
  if (!changes.length) return;
  const executor = await auditExecutor(newChannel.guild, 11, newChannel.id);
  await sendModerationLog(newChannel.guild, "channel", {
    channel: `${newChannel}`, action: "Channel updated", moderator: executor ? `${executor}` : "Unknown", details: changes.join("\n")
  });
});

client.on("roleUpdate", async (oldRole, newRole) => {
  const changes = [];
  if (oldRole.name !== newRole.name) changes.push(`Name: **${oldRole.name}** → **${newRole.name}**`);
  if (oldRole.color !== newRole.color) changes.push("Color changed");
  if (oldRole.hoist !== newRole.hoist) changes.push("Display separately changed");
  if (oldRole.mentionable !== newRole.mentionable) changes.push("Mentionable setting changed");
  if (!changes.length) return;
  const executor = await auditExecutor(newRole.guild, 31, newRole.id);
  await sendModerationLog(newRole.guild, "role", {
    action: "Role updated", moderator: executor ? `${executor}` : "Unknown", details: `<@&${newRole.id}>\n${changes.join("\n")}`
  });
});

/* =========================
   VOICE TRACKING
========================= */

client.on("guildMemberAdd", member => {
  if (member.user?.bot) return;
  recordNewMember(member.guild.id, member.id);
  updatePeakOnline(member.guild);
});

client.on("guildMemberRemove", member => {
  updatePeakOnline(member.guild);
});

client.on("presenceUpdate", (_oldPresence, newPresence) => {
  if (newPresence?.guild) updatePeakOnline(newPresence.guild);
});

client.on(
  "voiceStateUpdate",
  async (
    oldState,
    newState
  ) => {

    try {

      if (!newState.guild) {
        return;
      }

      const userId =
        newState.id;

      const guildId =
        newState.guild.id;

      const member =
        newState.member ||
        oldState.member;

      if (member?.user?.bot) {
        return;
      }

      const joined =
        !oldState.channelId &&
        !!newState.channelId;

      const left =
        !!oldState.channelId &&
        !newState.channelId;

      const moved =
        !!oldState.channelId &&
        !!newState.channelId &&
        oldState.channelId !== newState.channelId;

      if (moved) {
        await sendModerationLog(newState.guild, "voice", {
          user: `${member}`,
          channel: `${newState.channel}`,
          action: "Moved voice channel",
          details: `${oldState.channel ? oldState.channel.name : "Unknown"} → ${newState.channel ? newState.channel.name : "Unknown"}`
        });
      }

      if (oldState.serverMute !== newState.serverMute) {
        await sendModerationLog(newState.guild, "voice", {
          user: `${member}`, channel: `${newState.channel || oldState.channel}`,
          action: newState.serverMute ? "Server muted" : "Server unmuted"
        });
      }

      if (oldState.serverDeaf !== newState.serverDeaf) {
        await sendModerationLog(newState.guild, "voice", {
          user: `${member}`, channel: `${newState.channel || oldState.channel}`,
          action: newState.serverDeaf ? "Server deafened" : "Server undeafened"
        });
      }

      if (joined) {

        startVcSession(guildId, userId, Date.now());

        const user =
          getUser(
            userId,
            guildId
          );

        if (
          user.last_vc_join === null ||
          user.last_vc_join === undefined
        ) {

          setVcJoin(
            userId,
            guildId,
            Date.now()
          );

          console.log(
            `VC started: ${userId}`
          );
          await sendModerationLog(newState.guild, "voice", { user: `${member}`, channel: `${newState.channel}`, action: "Joined voice channel" });
        }

        return;
      }

      if (left) {

        endVcSession(guildId, userId, Date.now());

        settleVcSession(
          userId,
          guildId
        );

        console.log(
          `VC ended: ${userId}`
        );
        await sendModerationLog(newState.guild, "voice", { user: `${member}`, channel: `${oldState.channel}`, action: "Left voice channel" });

      }

    } catch (err) {

      console.error(
        "voiceStateUpdate error:",
        err
      );
    }
  }
);

/* =========================
   MODERATOR VC ACTIVITY TRACKING
========================= */
client.on("voiceStateUpdate", (oldState, newState) => {
  try {
    if (!newState.guild) return;
    if (!oldState.channelId && newState.channelId) startModVoiceTracking(oldState, newState);
    if (oldState.channelId && !newState.channelId) endModVoiceTracking(newState);
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      endModVoiceTracking(newState);
      startModVoiceTracking(oldState, newState);
    }
  } catch (err) {
    console.error("Moderator VC activity tracking error:", err);
  }
});

/* =========================
   INSTAGRAM ROLE SYNC
========================= */

client.on(
  "guildMemberUpdate",
  async (
    oldMember,
    newMember
  ) => {

    const role =
      newMember.guild.roles.cache.find(
        r =>
          r.name === "Instagram user"
      );

    if (!role) {
      return;
    }

    const hadRole =
      oldMember.roles.cache.has(
        role.id
      );

    const hasRole =
      newMember.roles.cache.has(
        role.id
      );

    if (
      hadRole &&
      !hasRole
    ) {

      removeInstagram(
        newMember.id,
        newMember.guild.id
      );

      console.log(
        `Instagram removed for ${newMember.user.tag} because role was removed`
      );
    }
  }
);

/* =========================
   INTERACTION HANDLER
========================= */

client.on(
  "interactionCreate",
  async interaction => {
    const interactionAgeMs = Date.now() - interaction.createdTimestamp;

    console.log(
      `INTERACTION RECEIVED: type=${interaction.type} command=${interaction.commandName || ""} customId=${interaction.customId || ""} id=${interaction.id} ageMs=${interactionAgeMs}`
    );

    try {

      if (!interaction.guild) {
        return;
      }

      /*
       * A Discord interaction must be acknowledged within ~3 seconds.
       * Acknowledge normal slash commands immediately, before any command
       * work can consume that window. The giveaway command is excluded
       * because its handler sends its own initial reply().
       */
      if (
        interaction.isChatInputCommand() &&
        interaction.commandName !== "giveaway" &&
        !interaction.deferred &&
        !interaction.replied
      ) {
        try {
          await interaction.deferReply();
        } catch (err) {
          console.error(
            `Interaction acknowledgement failed: command=${interaction.commandName} id=${interaction.id} ageMs=${Date.now() - interaction.createdTimestamp}`,
            err
          );
          return;
        }
      }

      /* =========================
         GIVEAWAY JOIN BUTTON
      ========================= */

      if (
        interaction.isButton() &&
        interaction.customId ===
          "giveaway_join"
      ) {

        const entries =
          giveawayCommand.giveawayEntries?.get(
            interaction.message.id
          );

        if (!entries) {

          return interaction.reply({
            content:
              "❌ This giveaway is no longer active.",
            ephemeral: true
          });
        }

        if (
          entries.has(
            interaction.user.id
          )
        ) {

          return interaction.reply({
            content:
              "⚠️ You are already entered in this giveaway!",
            ephemeral: true
          });
        }

        entries.add(
          interaction.user.id
        );

        const oldEmbed =
          interaction.message.embeds[0];

        if (oldEmbed) {

          const oldDescription =
            oldEmbed.description || "";

          const newDescription =
            oldDescription.replace(
              /👥 \*\*Entries:\*\* \d+/,
              `👥 **Entries:** ${entries.size}`
            );

          const updatedEmbed =
            EmbedBuilder
              .from(oldEmbed)
              .setDescription(
                newDescription
              );

          await interaction.message.edit({
            embeds: [
              updatedEmbed
            ]
          });
        }

        return interaction.reply({
          content:
            "🎉 You have successfully entered the giveaway! Good luck! 🍀",
          ephemeral: true
        });
      }

      /* =========================
         SLASH COMMAND CHECK
      ========================= */

      if (
        !interaction.isChatInputCommand()
      ) {
        return;
      }

      /* =========================
         GIVEAWAY SLASH COMMAND
         MUST HAPPEN BEFORE DEFER
      ========================= */

      if (
        interaction.commandName ===
        "giveaway"
      ) {

        try {

          return await giveawayCommand.execute(
            interaction
          );

        } catch (err) {

          console.error(
            "Giveaway command error:",
            err
          );

          if (
            interaction.replied ||
            interaction.deferred
          ) {

            return interaction
              .editReply({
                content:
                  "❌ An error occurred while creating the giveaway."
              })
              .catch(() => {});
          }

          return interaction
            .reply({
              content:
                "❌ An error occurred while creating the giveaway.",
              ephemeral: true
            })
            .catch(() => {});
        }
      }

      // Leader currently exposes only the giveaway slash command.
      return;

    } catch (err) {

      console.error(
        "Interaction error:",
        err
      );

      if (
        interaction.isRepliable()
      ) {

        if (
          interaction.replied ||
          interaction.deferred
        ) {

          await interaction
            .editReply({
              content:
                "❌ Something went wrong while processing this command."
            })
            .catch(() => {});

        } else {

          await interaction
            .reply({
              content:
                "❌ Something went wrong while processing this command.",
              ephemeral: true
            })
            .catch(() => {});
        }
      }
    }
  }
);

/* =========================
   START BOT
========================= */

async function start() {

  const startupStartedAt = Date.now();

  try {

    console.log("START: Initializing database...");
    await initDb();
    console.log(
      `START: Database initialized in ${Date.now() - startupStartedAt}ms.`
    );

    console.log("START: Attempting Discord login...");
    const loginStartedAt = Date.now();

    await client.login(
      config.token
    );

    console.log(
      `START: Discord login() completed in ${Date.now() - loginStartedAt}ms.`
    );

  } catch (err) {

    console.error(
      "Startup failed:",
      err
    );

    process.exit(1);
  }
}

start();

/* =========================
   ERROR HANDLERS
========================= */

process.on(
  "unhandledRejection",
  err =>
    console.error(
      "Unhandled promise rejection:",
      err
    )
);

process.on(
  "uncaughtException",
  err =>
    console.error(
      "Uncaught exception:",
      err
    )
);

/* =========================
   PROCESS LIFECYCLE DIAGNOSTICS
========================= */

process.on("beforeExit", code => {
  console.log(`PROCESS beforeExit: code=${code}`);
});

process.on("exit", code => {
  console.log(`PROCESS exit: code=${code}`);
});

/* =========================
   SHUTDOWN
========================= */

let shuttingDown = false;

async function shutdown(signal) {

  console.warn(`PROCESS SHUTDOWN REQUESTED: signal=${signal} uptime=${Math.round(process.uptime())}s`);

  if (shuttingDown) {
    console.log(`Shutdown already in progress; ignoring ${signal}.`);
    return;
  }

  shuttingDown = true;

  console.log(
    `${signal} received. Saving data and shutting down...`
  );

  try {

    await Promise.race([
      closeDb(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);

  } catch (err) {

    console.error(
      "Database shutdown error:",
      err.message
    );
  }

  try {

    client.destroy();

  } catch {}

  // Gracefully close the HTTP listener before the platform terminates the process.
  try {
    if (healthServer) {
      await new Promise(resolve => healthServer.close(() => resolve()));
    }
  } catch (err) {
    console.error("Health server shutdown error:", err.message);
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

