/* Vehicle Life - Discord connection diagnostics enabled */
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
const { vehicles } = require("./vehicles");
const { getVehicleRequirement } = require("./vehicle-progression");
const vehicleGame = require("./game");

const {
  getUser,
  addMessage,
  addVcSeconds,
  settleVcSession,
  setVcJoin,
  clearVcJoin,
  setVehicleIndex,
  topUsers,
  setInstagram,
  removeInstagram,
  close: closeDb,
  init: initDb
} = require("./db");

const {
  profileEmbed,
  profileFiles,
  garagePage,
  topGaragesEmbed
} = require("./cards");

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
  setTopGaragesChannel,
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
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      res.end("Vehicle Life is running\n");
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
   MODERATION LOGS + WARNINGS
========================= */

const MOD_LOG_CONFIG_FILE = path.join(__dirname, "moderation-logs.json");
const WARNINGS_FILE = path.join(__dirname, "warnings.json");
let moderationLogChannels = {};
let warningsStore = {};
const spamState = new Map();

function loadJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (err) {
    console.error(`Could not load ${path.basename(file)}:`, err);
    return fallback;
  }
}

function saveJsonFile(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Could not save ${path.basename(file)}:`, err);
  }
}

moderationLogChannels = loadJsonFile(MOD_LOG_CONFIG_FILE, {});
warningsStore = loadJsonFile(WARNINGS_FILE, {});

function nextModerationCaseId(guildId) {
  const key = `case:${guildId}`;
  const current = Number(warningsStore[key] || 0) + 1;
  warningsStore[key] = current;
  saveJsonFile(WARNINGS_FILE, warningsStore);
  return current;
}

function getWarnList(guildId, userId) {
  const key = `${guildId}:${userId}`;
  if (!Array.isArray(warningsStore[key])) warningsStore[key] = [];
  return warningsStore[key];
}

function addWarning(guildId, userId, data) {
  const key = `${guildId}:${userId}`;
  const list = getWarnList(guildId, userId);
  list.push({ ...data });
  warningsStore[key] = list;
  saveJsonFile(WARNINGS_FILE, warningsStore);
  return list;
}

function removeLatestWarning(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const list = getWarnList(guildId, userId);
  const removed = list.pop() || null;
  warningsStore[key] = list;
  saveJsonFile(WARNINGS_FILE, warningsStore);
  return removed;
}

function normalizeSpamText(content) {
  return String(content || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function sendModerationLog(guild, type, fields = {}, options = {}) {
  try {
    const channelId = moderationLogChannels[guild.id];
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTimestamp(options.timestamp ? new Date(options.timestamp) : new Date())
      .setFooter({ text: `Leader • Moderation Logs${options.caseId ? ` • Case #${options.caseId}` : ""}` });

    if (options.color) embed.setColor(options.color);
    if (options.title) embed.setTitle(options.title);
    if (options.description) embed.setDescription(options.description);

    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      embed.addFields({ name: String(name), value: String(value).slice(0, 1024), inline: options.inline !== false });
    }

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Moderation log error (${type}):`, err);
  }
}

async function findAuditExecutor(guild, actionType, targetId, maxAgeMs = 10000) {
  try {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 6 });
    const now = Date.now();
    const entry = logs.entries.find(e =>
      e.target?.id === targetId &&
      now - e.createdTimestamp <= maxAgeMs
    );
    return entry?.executor || null;
  } catch {
    return null;
  }
}

async function applyWarning(guild, targetMember, moderator, reason, source = "Moderator") {
  const caseId = nextModerationCaseId(guild.id);
  const now = Date.now();
  const list = addWarning(guild.id, targetMember.id, {
    caseId,
    moderatorId: moderator?.id || client.user?.id,
    reason,
    source,
    timestamp: now
  });

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayWarnings = list.filter(w => Number(w.timestamp) >= dayStart.getTime());

  let jailed = false;
  if (todayWarnings.length >= 3 && targetMember.moderatable) {
    try {
      await targetMember.timeout(60 * 60 * 1000, "3 warnings in one day");
      jailed = true;
    } catch (err) {
      console.error("Automatic 1-hour jail failed:", err);
    }
  }

  await sendModerationLog(guild, "warning", {
    "Member": `${targetMember} (${targetMember.user.tag})`,
    "Moderator": moderator ? `${moderator} (${moderator.tag || moderator.username})` : "Leader",
    "Reason": reason,
    "Source": source,
    "Today's Warnings": `${todayWarnings.length}/3`,
    "Action": jailed ? "1-hour timeout applied" : "Warning issued"
  }, { title: jailed ? "🔒 MEMBER JAILED" : "⚠️ WARNING ISSUED", color: jailed ? 0xE67E22 : 0xF1C40F, caseId });

  return { caseId, count: todayWarnings.length, jailed };
}

async function checkAntiSpam(message) {
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const normalized = normalizeSpamText(message.content);
  if (!normalized || normalized.startsWith("?")) {
    spamState.delete(key);
    return;
  }

  const previous = spamState.get(key);
  if (!previous || now - previous.lastAt > 60_000 || previous.text !== normalized) {
    spamState.set(key, { text: normalized, count: 1, lastAt: now });
    return;
  }

  previous.count += 1;
  previous.lastAt = now;
  spamState.set(key, previous);

  if (previous.count === 3) {
    const result = await applyWarning(message.guild, message.member, client.user, `Repeated identical message 3 times within 1 minute: “${message.content.slice(0, 180)}”`, "Auto Anti-Spam");
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle("⚠️ Anti-Spam Warning")
        .setDescription(`${message.author} has received an automatic warning.`)
        .addFields(
          { name: "Reason", value: "The same message was sent 3 consecutive times within 1 minute." },
          { name: "Today's Warnings", value: `${result.count}/3`, inline: true },
          { name: "Case", value: `#${result.caseId}`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "Leader • Automated Moderation" })],
      allowedMentions: { users: [message.author.id] }
    }).catch(() => {});
  }
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
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View your Vehicle Life profile"),

  new SlashCommandBuilder()
    .setName("garage")
    .setDescription("View your complete vehicle collection"),

  new SlashCommandBuilder()
    .setName("viewgarage")
    .setDescription("View another member's vehicle collection")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("The member whose garage you want to view")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("topgarages")
    .setDescription("Refresh the Top Garages leaderboard"),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set the current channel as the Top Garages channel")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),


].map(command => command.toJSON());

/* =========================
   DEPLOY COMMANDS
========================= */

async function deployCommands() {
  const rest = new REST({
    version: "10"
  }).setToken(config.token);

  // Register globally so the bot can serve every guild it is installed in.
  // Do not use config.guildId here: a stale/incorrect guild ID causes
  // Discord 50001 (Missing Access) and prevents command deployment.
  await rest.put(
    Routes.applicationCommands(config.clientId),
    {
      body: commands
    }
  );

  console.log(
    `Global slash commands registered for ${client.guilds.cache.size} server(s).`
  );
}

/* =========================
   VEHICLE UNLOCK SYSTEM
========================= */

function getProgressionRequirements(vehicleId, totalVehicles = vehicles.length) {
  return getVehicleRequirement(vehicleId, totalVehicles);
}

async function checkUnlocks(guild, userId) {
  const user = getUser(userId, guild.id);
  let index = Math.max(0, Math.min(Number(user.vehicle_index) || 0, vehicles.length));
  const hours = Number(user.vc_seconds || 0) / 3600;
  const messages = Number(user.messages || 0);
  const unlocked = [];

  // Catch up all eligible vehicles. This also repairs players who already had
  // enough activity before a progression-curve update or bot restart.
  while (index < vehicles.length) {
    const requirements = getProgressionRequirements(index + 1, vehicles.length);
    if (hours < requirements.hours || messages < requirements.messages) break;

    const unlockIndex = index + 1;
    try {
      const result = await vehicleGame.grantProgressionVehicle(guild.id, userId, unlockIndex);
      index = unlockIndex;
      setVehicleIndex(userId, guild.id, index);
      if (result?.granted !== false) unlocked.push(vehicles[unlockIndex - 1]);
    } catch (err) {
      console.error("Could not add progression vehicle to garage:", err);
      break;
    }
  }

  if (!unlocked.length) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  const channel = guild.systemChannel;
  if (!channel) return;

  const names = unlocked.map(v => `${v.emoji} **${v.name}**`).join('\n');
  await channel.send(
    `🎉 **NEW VEHICLE${unlocked.length > 1 ? 'S' : ''} UNLOCKED!**\n` +
    `${member} unlocked:\n${names}\n` +
    `🏁 Collection: **${index}/${vehicles.length}**`
  ).catch(() => {});
}

async function getCardUser(guildId, userId) {
  return vehicleGame.getDisplayUser(guildId, userId);
}

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

  await channel.send({
    content: "📈 **VOICE TIME — DAILY GRAPH**",
    files: [images[0]]
  });

  await channel.send({
    content: "💬 **MESSAGES — DAILY GRAPH**",
    files: [images[1]]
  });

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
      "Vehicle Life is online."
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

    // Send the command reference PDF by DM.
    if (message.content.trim().toLowerCase() === "?commands") {
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
          name: "Vehicle-Life-Commands.pdf"
        });

        await message.author.send({
          content: "📘 **Vehicle Life Bot — Command Reference**\n\nHere is the complete command guide:",
          files: [commandsPdf]
        });
      } catch (err) {
        console.error("Could not send command PDF DM:", err);
        // If the user's DMs are closed, send a helpful message in the server.
        await message.channel.send(
          `${message.author} ❌ I couldn't send you the PDF. Please enable DMs from server members and try \`?commands\` again.`
        ).catch(() => {});
      }
      return;
    }

    // Count every human message sent in the server, including command messages.
    recordMessageActivity(message.guild.id, message.author.id);

    const activityCommandResult = await handleActivityCommand(message);
    if (activityCommandResult !== false) {
      return;
    }

    // Vehicle Life V2 gameplay commands. These run before the legacy
    // progression/utility commands so ?buy, ?garage, ?race, economy, etc.
    // are handled by the new game system.
    const gameCommandResult = await vehicleGame.handle(message);
    if (gameCommandResult !== false) {
      return;
    }

    /* =========================
       CHANNEL SHORTCUTS
       ?setas chat -> current channel
       ?m chat inside any message -> channel mention
    ========================= */

    const content = message.content.trim();
    const lowerContent = content.toLowerCase();
    const manageGuild = message.member.permissions.has(PermissionFlagsBits.ManageGuild);

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
        await message.channel.send({
          content: "📈 **VOICE TIME — PROGRESS GRAPH**",
          files: [images[0]]
        });

        await message.channel.send({
          content: "💬 **MESSAGES — PROGRESS GRAPH**",
          files: [images[1]]
        });
      } catch (err) {
        console.error("Progression graph error:", err);
        await message.reply("❌ I couldn't generate the progression graphs. Check the bot logs.");
      }
      return;
    }

    if (lowerContent.startsWith("?setmodlogs")) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const channel = message.mentions.channels.first();
      if (!channel || !channel.isTextBased()) return message.reply("❌ Use `?setmodlogs #channel`.");
      moderationLogChannels[message.guild.id] = channel.id;
      saveJsonFile(MOD_LOG_CONFIG_FILE, moderationLogChannels);
      await message.reply(`✅ Full moderation logs will now be sent to ${channel}.`);
      await sendModerationLog(message.guild, "config", {
        "Configured by": `${message.author} (${message.author.tag})`,
        "Log Channel": `${channel}`
      }, { title: "⚙️ MODERATION LOGS CONFIGURED", color: 0x3498DB });
      return;
    }

    if (lowerContent === "?modlogs") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const channelId = moderationLogChannels[message.guild.id];
      return message.reply(channelId ? `📋 Moderation logs: <#${channelId}>` : "ℹ️ Moderation logs are not configured. Use `?setmodlogs #channel`.");
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

    await checkAntiSpam(message);

    /* =========================
       MESSAGE TRACKING
    ========================= */

    addMessage(
      message.author.id,
      message.guild.id,
      1
    );

    await checkUnlocks(
      message.guild,
      message.author.id
    );

    /* =========================
       PURGE COMMAND
       ?purge 10
    ========================= */

    if (
      message.content
        .toLowerCase()
        .startsWith("?purge")
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
          "❌ Usage: `?purge <1-100>`"
        );
      }

      try {

        const deleted =
          await message.channel.bulkDelete(
            amount,
            true
          );

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
       WARN / WARNS / UNWARN
    ========================= */

    if (lowerContent === "?warns" || lowerContent.startsWith("?warns ")) {
      const target = message.mentions.users.first();
      if (!target) return message.reply("❌ Use `?warns @user`.");
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("❌ You don't have permission to view warnings.");
      }
      const list = getWarnList(message.guild.id, target.id);
      if (!list.length) return message.reply(`✅ **${target.tag}** has no recorded warnings.`);
      const lines = list.slice(-15).map((w, i) => {
        const when = `<t:${Math.floor(Number(w.timestamp) / 1000)}:R>`;
        return `**#${w.caseId}** • ${w.source || "Moderator"} • ${when}\n${w.reason}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle(`⚠️ Warnings • ${target.tag}`)
        .setDescription(lines.join("\n\n").slice(0, 4000))
        .setFooter({ text: `Total warnings: ${list.length}` })
        .setTimestamp();
      return message.channel.send({ embeds: [embed] });
    }

    if (lowerContent.startsWith("?warn ") || lowerContent === "?warn") {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("❌ You don't have permission to warn members.");
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Use `?warn @user [reason]`.");
      const reason = content.split(/\s+/).slice(2).join(" ") || "No reason provided";
      const result = await applyWarning(message.guild, target, message.author, reason, "Moderator");
      return message.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(result.jailed ? 0xE67E22 : 0xF1C40F)
          .setTitle(result.jailed ? "🔒 Warning Issued • 1-Hour Jail" : "⚠️ Warning Issued")
          .setDescription(`${target} has received a warning.`)
          .addFields(
            { name: "Reason", value: reason.slice(0, 1024) },
            { name: "Today's Warnings", value: `${result.count}/3`, inline: true },
            { name: "Case", value: `#${result.caseId}`, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: "Leader • Moderation" })]
      });
    }

    if (lowerContent.startsWith("?unwarn") ) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("❌ You don't have permission to remove warnings.");
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Use `?unwarn @user`.");
      const removed = removeLatestWarning(message.guild.id, target.id);
      if (!removed) return message.reply("ℹ️ That member has no warnings to remove.");
      await sendModerationLog(message.guild, "unwarning", {
        "Member": `${target} (${target.user.tag})`,
        "Moderator": `${message.author} (${message.author.tag})`,
        "Removed Case": `#${removed.caseId}`,
        "Reason": removed.reason
      }, { title: "✅ WARNING REMOVED", color: 0x2ECC71, caseId: removed.caseId });
      return message.channel.send(`✅ Removed warning **#${removed.caseId}** from ${target}.`);
    }

    /* =========================
       SET NICKNAME
    ========================= */

    if (
      message.content.startsWith("?setnick")
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

    if (message.content.startsWith("?giverole")) {
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

    if (message.content.startsWith("?removerole")) {
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
      message.content.startsWith("?mute")
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
      message.content.startsWith("?unmute")
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
      message.content.startsWith("?addinsta")
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
      message.content.startsWith("?removeinsta")
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
      message.content.startsWith("?insta")
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
   PROFILE MESSAGE TRACKING
========================= */

const activeProfileMessages =
  new Map();

async function refreshProfileMessage(
  guildId,
  userId,
  channelId,
  messageId
) {

  try {

    const guild =
      client.guilds.cache.get(
        guildId
      );

    if (!guild) {
      return false;
    }

    const channel =
      await guild.channels
        .fetch(channelId)
        .catch(() => null);

    if (
      !channel ||
      !channel.isTextBased()
    ) {
      return false;
    }

    const message =
      await channel.messages
        .fetch(messageId)
        .catch(() => null);

    if (!message) {
      return false;
    }

    const member =
      await guild.members
        .fetch(userId)
        .catch(() => null);

    if (!member) {
      return false;
    }

    const user =
      getUser(
        userId,
        guildId
      );

    await message.edit({
      embeds: [
        profileEmbed(
          member,
          user
        )
      ],
      files:
        profileFiles(user)
    });

    return true;

  } catch (err) {

    console.error(
      "Profile refresh error:",
      err.message
    );

    return false;
  }
}

function rememberProfileMessage(
  guildId,
  userId,
  message
) {

  activeProfileMessages.set(
    `${guildId}:${userId}`,
    {
      guildId,
      userId,
      channelId:
        message.channelId,
      messageId:
        message.id
    }
  );
}

async function refreshAllProfiles() {

  for (
    const [
      key,
      info
    ] of activeProfileMessages
  ) {

    const ok =
      await refreshProfileMessage(
        info.guildId,
        info.userId,
        info.channelId,
        info.messageId
      );

    if (!ok) {
      activeProfileMessages.delete(
        key
      );
    }
  }
}

/* =========================
   PROFILE REFRESH TIMER
========================= */

const profileRefreshTimer =
  setInterval(
    refreshAllProfiles,
    60_000
  );

profileRefreshTimer.unref?.();

/* =========================
   FULL MODERATION AUDIT LOGS
========================= */

client.on("messageDelete", async message => {
  if (!message.guild || message.author?.bot) return;
  const executor = await findAuditExecutor(message.guild, 72, message.author?.id || message.id);
  await sendModerationLog(message.guild, "messageDelete", {
    "Author": message.author ? `${message.author} (${message.author.tag})` : "Unknown",
    "Channel": message.channel ? `${message.channel}` : "Unknown",
    "Content": message.content ? message.content.slice(0, 900) : "Content unavailable",
    "Deleted by": executor ? `${executor} (${executor.tag})` : "Unknown / not available"
  }, { title: "🗑️ MESSAGE DELETED", color: 0xE74C3C });
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  await sendModerationLog(newMessage.guild, "messageUpdate", {
    "Author": `${newMessage.author} (${newMessage.author.tag})`,
    "Channel": `${newMessage.channel}`,
    "Before": oldMessage.content ? oldMessage.content.slice(0, 450) : "Unavailable",
    "After": newMessage.content ? newMessage.content.slice(0, 450) : "Unavailable",
    "Message": `[Jump to message](${newMessage.url})`
  }, { title: "✏️ MESSAGE EDITED", color: 0xF1C40F });
});

client.on("guildBanAdd", async ban => {
  const executor = await findAuditExecutor(ban.guild, 22, ban.user.id);
  await sendModerationLog(ban.guild, "ban", {
    "Member": `${ban.user} (${ban.user.tag})`,
    "Moderator": executor ? `${executor} (${executor.tag})` : "Unknown",
    "Action": "Member banned"
  }, { title: "🔨 MEMBER BANNED", color: 0xE74C3C });
});

client.on("guildBanRemove", async ban => {
  const executor = await findAuditExecutor(ban.guild, 23, ban.user.id);
  await sendModerationLog(ban.guild, "unban", {
    "Member": `${ban.user} (${ban.user.tag})`,
    "Moderator": executor ? `${executor} (${executor.tag})` : "Unknown",
    "Action": "Ban removed"
  }, { title: "🔓 MEMBER UNBANNED", color: 0x2ECC71 });
});

client.on("guildMemberAdd", async member => {
  if (member.user.bot) return;
  await sendModerationLog(member.guild, "join", {
    "Member": `${member} (${member.user.tag})`,
    "Account Created": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`
  }, { title: "📥 MEMBER JOINED", color: 0x2ECC71 });
});

client.on("guildMemberRemove", async member => {
  if (member.user?.bot) return;
  const executor = await findAuditExecutor(member.guild, 20, member.id);
  await sendModerationLog(member.guild, "leave", {
    "Member": `${member.user ? member.user : member.id} (${member.user?.tag || "unknown"})`,
    "Removed by": executor ? `${executor} (${executor.tag})` : "Left server / unknown"
  }, { title: "📤 MEMBER LEFT", color: 0x95A5A6 });
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (newMember.user.bot) return;
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const added = [...newRoles].filter(id => !oldRoles.has(id));
  const removed = [...oldRoles].filter(id => !newRoles.has(id));
  if (added.length || removed.length) {
    await sendModerationLog(newMember.guild, "memberRoles", {
      "Member": `${newMember} (${newMember.user.tag})`,
      "Added": added.map(id => `<@&${id}>`).join(", ") || "None",
      "Removed": removed.map(id => `<@&${id}>`).join(", ") || "None"
    }, { title: "🎭 MEMBER ROLES UPDATED", color: 0x9B59B6 });
  }
  if (oldMember.nickname !== newMember.nickname) {
    const executor = await findAuditExecutor(newMember.guild, 24, newMember.id);
    await sendModerationLog(newMember.guild, "nickname", {
      "Member": `${newMember} (${newMember.user.tag})`,
      "Before": oldMember.nickname || "None",
      "After": newMember.nickname || "None",
      "Changed by": executor ? `${executor}` : "Unknown"
    }, { title: "🏷️ NICKNAME CHANGED", color: 0x3498DB });
  }
  if (oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp) {
    const executor = await findAuditExecutor(newMember.guild, 24, newMember.id);
    const active = !!newMember.communicationDisabledUntilTimestamp;
    await sendModerationLog(newMember.guild, "timeout", {
      "Member": `${newMember} (${newMember.user.tag})`,
      "Moderator": executor ? `${executor}` : "Unknown",
      "Status": active ? `Timed out until <t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:F>` : "Timeout removed"
    }, { title: active ? "🔇 MEMBER TIMED OUT" : "🔊 TIMEOUT REMOVED", color: active ? 0xE67E22 : 0x2ECC71 });
  }
});

client.on("roleCreate", async role => {
  const executor = await findAuditExecutor(role.guild, 30, role.id);
  await sendModerationLog(role.guild, "roleCreate", {
    "Role": `${role}`,
    "Name": role.name,
    "Created by": executor ? `${executor}` : "Unknown"
  }, { title: "🎭 ROLE CREATED", color: 0x9B59B6 });
});

client.on("roleDelete", async role => {
  const executor = await findAuditExecutor(role.guild, 32, role.id);
  await sendModerationLog(role.guild, "roleDelete", {
    "Role": role.name,
    "Role ID": role.id,
    "Deleted by": executor ? `${executor}` : "Unknown"
  }, { title: "🗑️ ROLE DELETED", color: 0xE74C3C });
});

client.on("roleUpdate", async (oldRole, newRole) => {
  if (oldRole.name === newRole.name && oldRole.permissions.bitfield === newRole.permissions.bitfield) return;
  const executor = await findAuditExecutor(newRole.guild, 31, newRole.id);
  await sendModerationLog(newRole.guild, "roleUpdate", {
    "Role": `${newRole}`,
    "Before": oldRole.name,
    "After": newRole.name,
    "Changed by": executor ? `${executor}` : "Unknown"
  }, { title: "✏️ ROLE UPDATED", color: 0xF1C40F });
});

client.on("channelCreate", async channel => {
  if (!channel.guild) return;
  const executor = await findAuditExecutor(channel.guild, 10, channel.id);
  await sendModerationLog(channel.guild, "channelCreate", {
    "Channel": `${channel}`,
    "Type": channel.type,
    "Created by": executor ? `${executor}` : "Unknown"
  }, { title: "📺 CHANNEL CREATED", color: 0x2ECC71 });
});

client.on("channelDelete", async channel => {
  if (!channel.guild) return;
  const executor = await findAuditExecutor(channel.guild, 12, channel.id);
  await sendModerationLog(channel.guild, "channelDelete", {
    "Channel": channel.name,
    "Channel ID": channel.id,
    "Deleted by": executor ? `${executor}` : "Unknown"
  }, { title: "🗑️ CHANNEL DELETED", color: 0xE74C3C });
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  const oldOverwrites = oldChannel.permissionOverwrites?.cache?.map(x => `${x.id}:${x.allow.bitfield}:${x.deny.bitfield}`).sort().join("|") || "";
  const newOverwrites = newChannel.permissionOverwrites?.cache?.map(x => `${x.id}:${x.allow.bitfield}:${x.deny.bitfield}`).sort().join("|") || "";
  if (oldChannel.name === newChannel.name && oldChannel.topic === newChannel.topic && oldOverwrites === newOverwrites) return;
  const executor = await findAuditExecutor(newChannel.guild, 11, newChannel.id);
  await sendModerationLog(newChannel.guild, "channelUpdate", {
    "Channel": `${newChannel}`,
    "Before": oldChannel.name,
    "After": newChannel.name,
    "Permission overwrites": oldOverwrites !== newOverwrites ? "Changed" : "Unchanged",
    "Changed by": executor ? `${executor}` : "Unknown"
  }, { title: "✏️ CHANNEL UPDATED", color: 0xF1C40F });
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

      if (joined || left || oldState.channelId !== newState.channelId) {
        await sendModerationLog(newState.guild, "voice", {
          "Member": `${member} (${member.user.tag})`,
          "From": oldState.channel ? `${oldState.channel}` : "Not in VC",
          "To": newState.channel ? `${newState.channel}` : "Not in VC"
        }, { title: joined ? "🔊 MEMBER JOINED VC" : left ? "🔇 MEMBER LEFT VC" : "🔄 MEMBER SWITCHED VC", color: 0x3498DB });
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

        await checkUnlocks(
          newState.guild,
          userId
        );
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

      // Vehicle Life V2 buttons (buy / betting / trading). These are
      // acknowledged directly and therefore must run before slash-command
      // defer logic.
      if (interaction.isButton()) {
        const gameButtonResult = await vehicleGame.handleButton(interaction);
        if (gameButtonResult !== false) {
          return;
        }
      }

      /*
       * A Discord interaction must be acknowledged within ~3 seconds.
       * Acknowledge normal slash commands immediately, before any command
       * work can consume that window. The giveaway command is excluded
       * because its handler sends its own initial reply().
       */
      if (
        interaction.isChatInputCommand() &&
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
         GARAGE VIEW BUTTONS
      ========================= */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "garageview:"
        )
      ) {

        const [
          ,
          direction,
          viewerId,
          targetId,
          pageText
        ] =
          interaction.customId.split(":");

        if (
          interaction.user.id !==
          viewerId
        ) {

          return interaction.reply({
            content:
              "❌ Only the person who opened this garage can use these buttons.",
            ephemeral: true
          });
        }

        const currentPage =
          Number(pageText) || 0;

        const nextPage =
          direction === "next"
            ? currentPage + 1
            : currentPage - 1;

        const targetMember =
          await interaction.guild.members
            .fetch(targetId)
            .catch(() => null);

        if (!targetMember) {

          return interaction.reply({
            content:
              "❌ That member is no longer in this server.",
            ephemeral: true
          });
        }

        const targetUser =
          await getCardUser(
            interaction.guild.id,
            targetId
          );

        const page =
          garagePage(
            targetMember,
            targetUser,
            nextPage
          );

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garageview:prev:${viewerId}:${targetId}:${page.page}`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garageview:next:${viewerId}:${targetId}:${page.page}`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.update({
          embeds: page.embeds,
          files: page.files,
          components: [row]
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
         NORMAL SLASH COMMANDS
      ========================= */

      console.log(
        `INTERACTION ACKNOWLEDGED: command=${interaction.commandName || "unknown"} id=${interaction.id} ageMs=${Date.now() - interaction.createdTimestamp}`
      );

      const user =
        await getCardUser(
          interaction.guild.id,
          interaction.user.id
        );

      /* =========================
         PROFILE
      ========================= */

      if (
        interaction.commandName ===
        "profile"
      ) {

        await interaction.editReply({
          embeds: [
            profileEmbed(
              interaction.member,
              user
            )
          ],
          files:
            profileFiles(user)
        });

        const profileMessage =
          await interaction
            .fetchReply()
            .catch(() => null);

        if (profileMessage) {

          rememberProfileMessage(
            interaction.guild.id,
            interaction.user.id,
            profileMessage
          );
        }

        return;
      }

      /* =========================
         GARAGE
      ========================= */

      if (
        interaction.commandName ===
        "garage"
      ) {

        const page =
          garagePage(
            interaction.member,
            user,
            0
          );

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garage:prev:${interaction.user.id}:0`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garage:next:${interaction.user.id}:0`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.editReply({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         VIEW GARAGE
      ========================= */

      if (
        interaction.commandName ===
        "viewgarage"
      ) {

        const targetUser =
          interaction.options.getUser(
            "user",
            true
          );

        const targetMember =
          await interaction.guild.members
            .fetch(targetUser.id)
            .catch(() => null);

        if (!targetMember) {

          return interaction.editReply({
            content:
              "❌ That user is not a member of this server.",
            ephemeral: true
          });
        }

        const targetData =
          await getCardUser(
            interaction.guild.id,
            targetUser.id
          );

        const page =
          garagePage(
            targetMember,
            targetData,
            0
          );

        const viewerId =
          interaction.user.id;

        const targetId =
          targetUser.id;

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garageview:prev:${viewerId}:${targetId}:0`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garageview:next:${viewerId}:${targetId}:0`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.editReply({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         TOP GARAGES
      ========================= */

      if (
        interaction.commandName ===
        "topgarages"
      ) {
        const rows = await vehicleGame.getTopGarages(interaction.guild.id, 10);
        if (!rows.length) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🏆 TOP GARAGES")
                .setDescription("No vehicle collections yet.")
            ]
          });
        }
        const desc = rows.map((x, i) => {
          const best = x.best ? `${x.best.emoji} ${x.best.name}` : "No vehicle";
          return `**#${i + 1} • ${best}**\n<@${x.user_id}> • **${x.owned.length}/${vehicleGame.vehicles.length} vehicles** • 🧑‍✈️ Lv.${x.driver_level}`;
        }).join("\n\n");
        return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle("🏆 TOP GARAGES").setDescription(desc)]
        });
      }

      /* =========================
         SETUP
      ========================= */

      if (
        interaction.commandName ===
        "setup"
      ) {

        if (
          !interaction.memberPermissions.has(
            PermissionFlagsBits.ManageGuild
          )
        ) {

          return interaction.editReply({
            content:
              "❌ You need Manage Server permission.",
            ephemeral: true
          });
        }

        if (
          interaction.channel.type !==
          ChannelType.GuildText
        ) {

          return interaction.editReply({
            content:
              "❌ Run this command inside a text channel.",
            ephemeral: true
          });
        }

        setTopGaragesChannel(interaction.guild.id, interaction.channel.id);
        return interaction.editReply({
          content:
            `✅ **Top Garages channel configured!**\n` +
            `Use \`/topgarages\` here to publish the leaderboard.`
        });
      }

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

let progressionRetryTimer = null;

function startProgressionRetryLoop() {
  if (progressionRetryTimer) return;
  progressionRetryTimer = setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (state.member?.user?.bot || !state.channelId) continue;
        await checkUnlocks(guild, state.id).catch(err =>
          console.error('Progression retry error:', err)
        );
      }
    }
  }, 15000);
}

client.once('ready', async () => {
  try { await vehicleGame.startAutomation(client); console.log('Vehicle Life automation started.'); }
  catch (err) { console.error('Vehicle Life automation startup failed:', err); }
  startProgressionRetryLoop();
});

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

  if (shuttingDown) {
    console.log(`Shutdown already in progress; ignoring ${signal}.`);
    return;
  }

  shuttingDown = true;

  console.log(
    `${signal} received. Saving data...`
  );

  try {

    await closeDb();

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

  if (progressionRetryTimer) {
    clearInterval(progressionRetryTimer);
    progressionRetryTimer = null;
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

