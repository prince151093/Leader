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
      const ready = client.isReady();
      res.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({ ok: ready, service: "Leader", uptime: Math.round(process.uptime()), discordReady: ready }));
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

const commands = [giveawayCommand.data].map(command => command.toJSON());

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

    restoreVoiceSessions(client);
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId) startTrackedModVc(state, state);
      }
    }
    await restoreJails();
    await scanMediaChannels();
    updatePeakOnlineForAllGuilds();
    runDailyProgressReports().catch(err => console.error("Initial daily progress report error:", err));

    // Run the moderator-alert scheduler immediately after Discord is ready.
    // This allows a configured alert to catch up after a restart.
    sendModAlerts().catch(err => console.error("Initial moderator alert check error:", err));

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
  const content = (message.commandContent || message.content).trim();
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
   MODERATION / MEDIA CONFIG
========================= */
const MOD_CONFIG_FILE = path.join(__dirname, "leader-moderation.json");
const COMMAND_PASSWORD = "admin@151093";
const MOD_TIME_ZONE = process.env.MOD_TIME_ZONE || "Asia/Kolkata";
const modState = new Map();
const activeModVc = new Map();
const spamState = new Map();
const spamWarnedAt = new Map();
function defaultModState(){return{mediaChannelId:null,modAlertChannelId:null,alertTime:"07:30",minReqVcSeconds:10800,minReqChat:300,vcModRoleId:null,chatModRoleId:null,warnings:{},jailed:{},activity:{},lastAlertDate:{}};}
function loadModState(){try{if(!fs.existsSync(MOD_CONFIG_FILE))return;const d=JSON.parse(fs.readFileSync(MOD_CONFIG_FILE,"utf8"));for(const[g,v]of Object.entries(d||{}))modState.set(g,{...defaultModState(),...(v||{})});}catch(e){console.error("Moderation config load error:",e);}}
function saveModState(){try{fs.writeFileSync(MOD_CONFIG_FILE,JSON.stringify(Object.fromEntries(modState),null,2));}catch(e){console.error("Moderation config save error:",e);}}
function getModState(g){if(!modState.has(g))modState.set(g,defaultModState());return modState.get(g);}
loadModState();
function zonedDateKey(d=new Date()){return new Intl.DateTimeFormat("en-CA",{timeZone:MOD_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);}
function zonedHourMinute(d=new Date()){const p=new Intl.DateTimeFormat("en-GB",{timeZone:MOD_TIME_ZONE,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d);return `${p.find(x=>x.type==="hour")?.value||"00"}:${p.find(x=>x.type==="minute")?.value||"00"}`;}
function parseClock(v){const m=String(v||"").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);if(!m)return null;let h=Number(m[1]),mi=Number(m[2]||0);if(mi>59)return null;if(m[3]){if(h<1||h>12)return null;if(m[3]==="am"&&h===12)h=0;if(m[3]==="pm"&&h!==12)h+=12;}if(h>23)return null;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;}
function parseDurationHours(v){const x=String(v||"").trim().toLowerCase();let m=x.match(/^(\d+(?:\.\d+)?)h$/);if(m)return Math.round(Number(m[1])*3600);m=x.match(/^(\d+)\s*:\s*(\d+(?:\.\d+)?)h$/);if(m)return Math.round(Number(m[1])*3600+Number(m[2])*60);return null;}
function isMediaMessage(m){if(!m.attachments?.size)return false;return m.attachments.some(a=>{const t=String(a.contentType||"").toLowerCase(),n=String(a.name||a.url||"").toLowerCase();return t.startsWith("image/")||t.startsWith("video/")||/\.(png|jpe?g|gif|webp|bmp|heic|heif|mp4|mov|mkv|webm|avi|m4v)$/i.test(n);});}
function commandNameOf(t){return String(t||"").trim().split(/\s+/)[0].toLowerCase();}
function isKnownLeaderCommand(t){return new Set(["?modpdf","?setmedia","?warn","?warns","?unwarn","?setmodalert","?setalerttime","?setminreqvc","?setminreqchat","?setvcmod","?setchatmod","?purge","?setdailyreportrole","?setasprogressviewchannel","?progress","?setas","?removeas","?listas","?m","?lock","?unlock","?activity","?setmainchannel","?setnick","?giverole","?removerole","?mute","?unmute","?addinsta","?removeinsta","?insta"]).has(commandNameOf(t));}
function cleanExpiredWarnings(g,u){const st=getModState(g),d=zonedDateKey();st.warnings[u]=(Array.isArray(st.warnings[u])?st.warnings[u]:[]).filter(w=>w&&w.date===d);return st.warnings[u];}
async function createJailRole(guild){let role=guild.roles.cache.find(r=>r.name.toLowerCase()==="jail");if(!role)role=await guild.roles.create({name:"Jail",reason:"Leader automatic moderation jail"}).catch(()=>null);if(!role)return null;for(const ch of guild.channels.cache.values()){if(!ch.isTextBased()&&ch.type!==ChannelType.GuildVoice)continue;await ch.permissionOverwrites.edit(role,{SendMessages:false,AddReactions:false,Connect:false,Speak:false,SendMessagesInThreads:false,CreatePublicThreads:false,CreatePrivateThreads:false}).catch(()=>{});}return role;}
async function releaseJail(g,u){const guild=client.guilds.cache.get(g),st=getModState(g);delete st.jailed[u];saveModState();if(!guild)return;const m=await guild.members.fetch(u).catch(()=>null);if(!m)return;const role=guild.roles.cache.find(r=>r.name.toLowerCase()==="jail");if(role)await m.roles.remove(role,"1 hour jail completed").catch(()=>{});}
async function jailMember(m,reason="3 warnings in one day"){const st=getModState(m.guild.id),until=Date.now()+3600000,role=await createJailRole(m.guild);if(role)await m.roles.add(role,reason).catch(()=>{});await m.timeout(3600000,reason).catch(()=>{});st.jailed[m.id]=until;saveModState();const ch=m.guild.channels.cache.get(st.modAlertChannelId);if(ch?.isTextBased())await ch.send(`🚨 ${m} has been placed in **Jail for 1 hour** because they reached **3 warnings today**.`).catch(()=>{});setTimeout(()=>releaseJail(m.guild.id,m.id).catch(()=>{}),3600000).unref?.();}
async function addWarning(g,u,moderator,reason,automatic=false){const st=getModState(g.id),list=cleanExpiredWarnings(g.id,u);list.push({date:zonedDateKey(),at:Date.now(),moderator:moderator||"Automatic",reason:reason||"No reason provided",automatic});saveModState();if(list.length>=3){const m=await g.members.fetch(u).catch(()=>null);if(m&&!m.user.bot)await jailMember(m);}return list.length;}
function getWarnings(g,u){return cleanExpiredWarnings(g,u).slice().sort((a,b)=>a.at-b.at);}
function incrementModMessageActivity(m){const st=getModState(m.guild.id),d=zonedDateKey();st.activity[d]??={};st.activity[d][m.author.id]??={messages:0,vcSeconds:0};if(st.chatModRoleId&&m.member?.roles.cache.has(st.chatModRoleId))st.activity[d][m.author.id].messages++;saveModState();}
function addModVcSeconds(g,u,sec){if(sec<=0)return;const st=getModState(g),guild=client.guilds.cache.get(g),m=guild?.members.cache.get(u);if(!m||!st.vcModRoleId||!m.roles.cache.has(st.vcModRoleId))return;const d=zonedDateKey();st.activity[d]??={};st.activity[d][u]??={messages:0,vcSeconds:0};st.activity[d][u].vcSeconds+=sec;}
function startTrackedModVc(oldS,newS){const st=getModState(newS.guild.id),m=newS.member||oldS.member;if(!st.vcModRoleId||!newS.channelId||!m||m.user.bot||!m.roles.cache.has(st.vcModRoleId))return;activeModVc.set(`${newS.guild.id}:${newS.id}`,{last:Date.now()});}
function endTrackedModVc(newS){const k=`${newS.guild.id}:${newS.id}`,s=activeModVc.get(k);if(!s)return;addModVcSeconds(newS.guild.id,newS.id,Math.floor((Date.now()-s.last)/1000));activeModVc.delete(k);saveModState();}
async function updateTrackedModVc(){for(const[k,s]of activeModVc){const[g,u]=k.split(":");const sec=Math.floor((Date.now()-s.last)/1000);if(sec>0){addModVcSeconds(g,u,sec);s.last=Date.now();}}saveModState();}
function activityFor(g,u){return getModState(g).activity?.[zonedDateKey()]?.[u]||{messages:0,vcSeconds:0};}
async function sendModAlerts({force=false,test=false}={}){
  const now = new Date();
  const currentMinute = zonedHourMinute(now);
  const currentDate = zonedDateKey(now);

  for (const guild of client.guilds.cache.values()) {
    try {
      const st = getModState(guild.id);
      if (!st.modAlertChannelId) continue;
      if (!force && st.lastAlertDate[currentDate]) continue;
      if (!force && currentMinute < st.alertTime) continue;

      const ch = guild.channels.cache.get(st.modAlertChannelId);
      if (!ch?.isTextBased()) continue;

      await guild.members.fetch().catch(() => null);

      // Add currently connected VC moderators to tracking if they were already
      // in VC when their role was configured or when the bot restarted.
      if (st.vcModRoleId) {
        for (const m of guild.members.cache.values()) {
          if (m.user.bot || !m.voice?.channelId) continue;
          if (!m.roles.cache.has(st.vcModRoleId)) continue;
          const key = `${guild.id}:${m.id}`;
          if (!activeModVc.has(key)) activeModVc.set(key, {last: Date.now()});
        }
      }

      // Capture all elapsed time up to the exact moment of the check.
      await updateTrackedModVc();

      const vcWarnings = [];
      const chatWarnings = [];
      const vcRequired = Number(st.minReqVcSeconds) || 0;
      const chatRequired = Number(st.minReqChat) || 0;

      for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;

        // VC moderators are judged ONLY by VC time.
        if (st.vcModRoleId && m.roles.cache.has(st.vcModRoleId)) {
          const a = activityFor(guild.id, m.id);
          const vcSeconds = Number(a.vcSeconds) || 0;
          if (vcSeconds < vcRequired) {
            vcWarnings.push({
              id: m.id,
              mention: `<@${m.id}>`,
              done: formatReportDuration(vcSeconds),
              required: formatReportDuration(vcRequired),
              short: formatReportDuration(vcRequired - vcSeconds)
            });
          }
        }

        // Chat moderators are judged ONLY by message count.
        if (st.chatModRoleId && m.roles.cache.has(st.chatModRoleId)) {
          const a = activityFor(guild.id, m.id);
          const messages = Number(a.messages) || 0;
          if (messages < chatRequired) {
            chatWarnings.push({
              id: m.id,
              mention: `<@${m.id}>`,
              done: messages,
              required: chatRequired,
              short: chatRequired - messages
            });
          }
        }
      }

      // Nothing to warn about. A scheduled check does not send a useless
      // message; a manual test does send a clear result so the admin knows
      // the system is working.
      if (!vcWarnings.length && !chatWarnings.length) {
        if (test) {
          const embed = new EmbedBuilder()
            .setTitle('✅ MODERATOR ACTIVITY CHECK')
            .setDescription('All configured moderators have completed their respective daily requirements.')
            .setFooter({text: `Daily check • ${MOD_TIME_ZONE}`})
            .setTimestamp();
          await ch.send({embeds:[embed]}).catch(err => console.error('Mod alert test send error:', err));
        }
        continue;
      }

      const lines = [];
      const mentions = [];

      if (vcWarnings.length) {
        lines.push('🎙️ **VC MODERATORS — ACTION REQUIRED**');
        for (const w of vcWarnings) {
          lines.push(`${w.mention} — **${w.done} / ${w.required}** completed • **${w.short} remaining**`);
          mentions.push(w.id);
        }
      }

      if (chatWarnings.length) {
        if (lines.length) lines.push('');
        lines.push('💬 **CHAT MODERATORS — ACTION REQUIRED**');
        for (const w of chatWarnings) {
          lines.push(`${w.mention} — **${w.done} / ${w.required} messages** • **${w.short} remaining**`);
          mentions.push(w.id);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(test ? '🧪 MODERATOR ACTIVITY TEST' : '🔔 MODERATOR ACTIVITY ALERT')
        .setDescription([
          test ? '**Test notification:** the following moderators are currently below their own daily requirement.' : '**Daily moderator activity check:** please complete your assigned requirement before the end of the day.',
          '',
          ...lines
        ].join('\n'))
        .setFooter({text: `Daily requirements • ${MOD_TIME_ZONE}`})
        .setTimestamp();

      const uniqueMentions = [...new Set(mentions)];
      await ch.send({
        content: uniqueMentions.map(id => `<@${id}>`).join(' '),
        embeds: [embed],
        allowedMentions: {users: uniqueMentions}
      });

      // Only mark the real scheduled alert as sent. A manual test must never
      // block the real daily notification.
      if (!test) {
        st.lastAlertDate[currentDate] = true;
        saveModState();
      }
    } catch (err) {
      console.error(`Moderator alert error for guild ${guild.id}:`, err);
    }
  }
}
async function scanMediaChannels(){for(const[g,st]of modState){if(!st.mediaChannelId)continue;const guild=client.guilds.cache.get(g),ch=guild?.channels.cache.get(st.mediaChannelId);if(!ch?.isTextBased())continue;const msgs=await ch.messages.fetch({limit:10}).catch(()=>null);if(!msgs)continue;for(const m of msgs.values()){if(m.author.bot)continue;if(m.content.trim().startsWith("?")&&isKnownLeaderCommand(m.content))continue;if(!isMediaMessage(m)){await m.delete().catch(()=>{});}}}}
async function restoreJails(){for(const[g,st]of modState){for(const[u,until]of Object.entries(st.jailed||{})){const rem=Number(until)-Date.now();if(rem<=0)await releaseJail(g,u);else setTimeout(()=>releaseJail(g,u).catch(()=>{}),rem).unref?.();}}}
setInterval(()=>updateTrackedModVc().catch(console.error),60000);

// Reliable moderator-alert scheduler. It checks every 5 seconds after the
// configured local time and also catches up if the bot restarted after the
// configured time. This is intentionally NOT unref()'d.
let modAlertLoopRunning = false;
setInterval(async () => {
  if (modAlertLoopRunning) return;
  modAlertLoopRunning = true;
  try {
    await sendModAlerts();
  } catch (err) {
    console.error("Moderator alert scheduler error:", err);
  } finally {
    modAlertLoopRunning = false;
  }
}, 5000);

setInterval(()=>scanMediaChannels().catch(console.error),60000);

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
    const rawContent = message.content.trim();
    let content = rawContent;
    const isPrefixCommand = rawContent.startsWith("?");

    // ONLY these six alert-system configuration commands require the admin
    // password. Normal moderation/help commands never require it.
    const passwordCommandNames = new Set([
      "?setmodalert",
      "?setalerttime",
      "?setminreqvc",
      "?setminreqchat",
      "?setvcmod",
      "?setchatmod"
    ]);

    const firstCommand = commandNameOf(rawContent);
    const needsPassword = isPrefixCommand && passwordCommandNames.has(firstCommand);

    if (needsPassword) {
      // Delete the credential-bearing message first so the password is not
      // left visible in the server channel or chat history.
      await message.delete().catch(() => {});

      const parts = rawContent.split(/\s+/);
      const suppliedPassword = parts.length > 1 ? parts[parts.length - 1] : "";

      if (suppliedPassword !== COMMAND_PASSWORD) {
        const reply = await message.channel.send(`${message.author} ❌ Invalid admin password.`).catch(() => null);
        if (reply) setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
      }

      // Strip the password before any command handler sees it. It must never
      // be echoed, logged, or included in a bot response.
      content = parts.slice(0, -1).join(" ").trim();
      message.commandContent = content;
    } else {
      message.commandContent = rawContent;
    }

    const mediaState = getModState(message.guild.id);
    if (mediaState.mediaChannelId === message.channel.id) {
      if (isPrefixCommand && !isKnownLeaderCommand(content)) {
        const reply = await message.channel.send(`${message.author} ❌ Only Leader commands are allowed here, and they require the admin password.`).catch(() => null);
        await message.delete().catch(() => {});
        if (reply) setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
      }
      if (!isPrefixCommand && !isMediaMessage(message)) {
        await message.delete().catch(() => {});
        return;
      }
    }

    const spamKey = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const recent = (spamState.get(spamKey) || []).filter(x => now - x.at < 60000);
    recent.push({ at: now, content: rawContent });
    const last3 = recent.slice(-3);
    spamState.set(spamKey, recent.slice(-10));
    if (last3.length === 3 && last3.every(x => x.content === last3[0].content) && spamWarnedAt.get(spamKey) !== last3[0].at) {
      spamWarnedAt.set(spamKey, last3[0].at);
      const count = await addWarning(message.guild, message.author.id, "Leader Anti-Spam", "Sent the same message 3 times back-to-back within 1 minute.", true);
      const warnMsg = await message.channel.send(`⚠️ ${message.author} has received an **automatic warning** for repeated spam. Warnings today: **${count}/3**`).catch(() => null);
      if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), 5000);
    }

    recordMessageActivity(message.guild.id, message.author.id);
    incrementModMessageActivity(message);

    const activityCommandResult = await handleActivityCommand(message);
    if (activityCommandResult !== false) {
      return;
    }
/* =========================
       CHANNEL SHORTCUTS
       ?setas chat -> current channel
       ?m chat inside any message -> channel mention
    ========================= */

    const lowerContent = content.toLowerCase();
    const manageGuild = message.member.permissions.has(PermissionFlagsBits.ManageGuild);

    if (lowerContent === "?modpdf") {
      const pdf = path.join(__dirname, "Leader-Commands.pdf");
      if (!fs.existsSync(pdf)) return message.reply("❌ Leader-Commands.pdf is missing.");
      try { await message.author.send({ content: "📘 **Leader — Moderator Command Reference**", files: [new AttachmentBuilder(pdf,{name:"Leader-Commands.pdf"})] }); return message.reply("✅ Moderator PDF sent to your DMs."); }
      catch { return message.reply("❌ I couldn't DM you. Please enable DMs from server members."); }
    }
    if (lowerContent.startsWith("?setmedia")) {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const st=getModState(message.guild.id), arg=content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "off") { st.mediaChannelId=null; saveModState(); return message.reply("✅ Media-only mode disabled."); }
      st.mediaChannelId=message.channel.id; saveModState();
      return message.reply(`📸 **Media-only channel enabled:** ${message.channel}\nOnly photos and videos are allowed here.`);
    }
    if (lowerContent.startsWith("?warns")) {
      const target=message.mentions.users.first(); if(!target)return message.reply("❌ Use `?warns @user admin@151093`.");
      const list=getWarnings(message.guild.id,target.id); if(!list.length)return message.reply(`ℹ️ ${target} has **0 warnings today**.`);
      return message.reply(`⚠️ **Warnings for ${target} — today: ${list.length}**\n${list.map((w,i)=>`${i+1}. ${w.automatic?"🤖 Auto":"👮 Mod"} — ${w.reason} — <t:${Math.floor(w.at/1000)}:R>`).join("\n")}`);
    }
    if (lowerContent.startsWith("?setmodalert")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const st=getModState(message.guild.id);st.modAlertChannelId=message.channel.id;saveModState();return message.reply(`✅ Mod alert channel set to ${message.channel}.`); }
    if (lowerContent.startsWith("?setalerttime")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const a=content.split(/\s+/)[1],t=parseClock(a);if(!t)return message.reply("❌ Example: `?setalerttime 7:30am admin@151093`.");const st=getModState(message.guild.id);st.alertTime=t;saveModState();return message.reply(`✅ Daily mod alert time set to **${a}** (${MOD_TIME_ZONE}).`); }
    if (lowerContent.startsWith("?setminreqvc")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const a=content.split(/\s+/)[1],sec=parseDurationHours(a);if(!sec)return message.reply("❌ Example: `?setminreqvc 3h admin@151093` or `?setminreqvc 2:30h admin@151093`.");const st=getModState(message.guild.id);st.minReqVcSeconds=sec;saveModState();return message.reply(`✅ Daily VC-mod minimum set to **${formatReportDuration(sec)}**.`); }
    if (lowerContent.startsWith("?setminreqchat")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const a=Number(content.split(/\s+/)[1]);if(!Number.isInteger(a)||a<1)return message.reply("❌ Example: `?setminreqchat 300 admin@151093`.");const st=getModState(message.guild.id);st.minReqChat=a;saveModState();return message.reply(`✅ Daily chat-mod minimum set to **${a} messages**.`); }
    if (lowerContent.startsWith("?setvcmod")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const role=message.mentions.roles.first();if(!role)return message.reply("❌ Use `?setvcmod @role admin@151093`.");const st=getModState(message.guild.id);st.vcModRoleId=role.id;saveModState();return message.reply(`✅ VC mod alert role set to ${role}.`); }
    if (lowerContent.startsWith("?setchatmod")) { if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");const role=message.mentions.roles.first();if(!role)return message.reply("❌ Use `?setchatmod @role admin@151093`.");const st=getModState(message.guild.id);st.chatModRoleId=role.id;saveModState();return message.reply(`✅ Chat mod alert role set to ${role}.`); }
    if (lowerContent === "?modalertstatus") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      const st=getModState(message.guild.id);
      return message.reply([
        "📊 **Moderator Alert Status**",
        `• Alert channel: ${st.modAlertChannelId ? `<#${st.modAlertChannelId}>` : "Not set"}`,
        `• Alert time: **${st.alertTime || "Not set"}** (${MOD_TIME_ZONE})`,
        `• VC role: ${st.vcModRoleId ? `<@&${st.vcModRoleId}>` : "Not set"}`,
        `• Chat role: ${st.chatModRoleId ? `<@&${st.chatModRoleId}>` : "Not set"}`,
        `• VC minimum: **${formatReportDuration(Number(st.minReqVcSeconds)||0)}**`,
        `• Chat minimum: **${Number(st.minReqChat)||0} messages**`,
        `• Last alert today: **${Boolean(st.lastAlertDate?.[zonedDateKey()]) ? "Yes" : "No"}**`
      ].join("\n"));
    }
    if (lowerContent === "?modalerttest") {
      if (!manageGuild) return message.reply("❌ You need **Manage Server** permission.");
      await sendModAlerts({force:true,test:true});
      return message.reply("✅ Moderator activity test completed. Check the mod-alerts channel.");
    }
    if (lowerContent.startsWith("?warn ")) { if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))return message.reply("❌ You don't have permission to warn members.");const target=message.mentions.users.first();if(!target)return message.reply("❌ Please mention a user.");const reason=content.split(/\s+/).slice(2).join(" ")||"No reason provided";const count=await addWarning(message.guild,target.id,message.author.tag,reason,false);return message.reply(`⚠️ ${target} has been warned.\nReason: ${reason}\nWarnings today: **${count}/3**${count>=3?"\n🚨 **Jail applied for 1 hour.**":""}`); }
    if (lowerContent.startsWith("?unwarn ")) { if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))return message.reply("❌ You don't have permission to remove warnings.");const target=message.mentions.users.first();if(!target)return message.reply("❌ Please mention a user.");const st=getModState(message.guild.id),list=getWarnings(message.guild.id,target.id);if(!list.length)return message.reply(`ℹ️ ${target} has no warnings today.`);list.pop();st.warnings[target.id]=list;saveModState();return message.reply(`✅ Removed the most recent warning from ${target}. Warnings today: **${list.length}**.`); }

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
       PURGE COMMAND
       ?purge 10
    ========================= */

    if (
      content
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
        content.trim().split(/\s+/);

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
       SET NICKNAME
    ========================= */

    if (
      content.startsWith("?setnick")
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
        content
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

    if (content.startsWith("?giverole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      // The role can be mentioned in the command so Discord resolves it
      // automatically. The bot NEVER mentions the role in its own messages.
      const role = message.mentions.roles.first() || (() => {
        const roleInput = content
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

    if (content.startsWith("?removerole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      // The role can be mentioned in the command so Discord resolves it
      // automatically. The bot NEVER mentions the role in its own messages.
      const role = message.mentions.roles.first() || (() => {
        const roleInput = content
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
      content.startsWith("?mute")
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
        content
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
      content.startsWith("?unmute")
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
      content.startsWith("?addinsta")
    ) {

      const username =
        content
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
      content.startsWith("?removeinsta")
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
      content.startsWith("?insta")
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

      if (joined) {

        startTrackedModVc(oldState, newState);
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

        endTrackedModVc(newState);
        endVcSession(guildId, userId, Date.now());

        settleVcSession(
          userId,
          guildId
        );

        console.log(
          `VC ended: ${userId}`
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

client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.guild) return;
    if (interaction.isButton() && interaction.customId === "giveaway_join") {
      const entries = giveawayCommand.giveawayEntries?.get(interaction.message.id);
      if (!entries) return interaction.reply({ content: "❌ This giveaway is no longer active.", ephemeral: true });
      if (entries.has(interaction.user.id)) return interaction.reply({ content: "⚠️ You are already entered in this giveaway!", ephemeral: true });
      entries.add(interaction.user.id);
      const oldEmbed = interaction.message.embeds[0];
      if (oldEmbed) {
        const desc = (oldEmbed.description || "").replace(/👥 \*\*Entries:\*\* \d+/, `👥 **Entries:** ${entries.size}`);
        await interaction.message.edit({ embeds: [EmbedBuilder.from(oldEmbed).setDescription(desc)] }).catch(() => {});
      }
      return interaction.reply({ content: "🎉 You have successfully entered the giveaway! Good luck! 🍀", ephemeral: true });
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "giveaway") return await giveawayCommand.execute(interaction).catch(async err => {
      console.error("Giveaway command error:", err);
      const payload = { content: "❌ An error occurred while creating the giveaway.", ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    });
  } catch (err) { console.error("Interaction error:", err); }
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
    `${signal} received. Saving data and shutting down...`
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

