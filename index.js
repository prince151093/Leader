/* LEADER — Server / Moderation / Activity Bot */
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
  EmbedBuilder
} = require("discord.js");

const config = require("./config");
const giveawayCommand = require("./src/commands/giveaway");
const specialWelcome = require("./special-welcome");
const moderationData = require("./moderation-data");
const {
  getUser,
  addMessage,
  settleVcSession,
  setVcJoin,
  clearVcJoin,
  setInstagram,
  removeInstagram,
  close: closeDb,
  init: initDb
} = require("./db");
const {
  flushProgression,
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
  dateKey
} = require("./progression");

if (!config.token) { console.error("Missing DISCORD_TOKEN environment variable."); process.exit(1); }
if (!config.clientId) { console.error("Missing CLIENT_ID environment variable."); process.exit(1); }
if (!config.supabaseUrl) { console.error("Missing SUPABASE_URL environment variable."); process.exit(1); }
if (!config.supabaseServiceRoleKey) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable."); process.exit(1); }

let healthServer = null;
function startHealthServer() {
  const port = Number(process.env.PORT);
  if (!port) return;
  healthServer = http.createServer((req,res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, {"Content-Type":"text/plain; charset=utf-8"});
      return res.end("LEADER Bot is running\n");
    }
    res.writeHead(404); res.end("Not found\n");
  });
  healthServer.listen(port, "0.0.0.0", () => console.log(`Health server listening on port ${port}`));
}
startHealthServer();

const CHANNEL_SHORTCUTS_FILE = path.join(__dirname, "channel-shortcuts.json");
let channelShortcuts = {};
function loadChannelShortcuts() {
  try {
    if (fs.existsSync(CHANNEL_SHORTCUTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNEL_SHORTCUTS_FILE,"utf8"));
      channelShortcuts = data && typeof data === "object" ? data : {};
    }
  } catch (err) { console.error("Channel shortcut load error:", err); channelShortcuts = {}; }
}
function saveChannelShortcuts() {
  try { fs.writeFileSync(CHANNEL_SHORTCUTS_FILE, JSON.stringify(channelShortcuts,null,2)); }
  catch (err) { console.error("Channel shortcut save error:", err); }
}
loadChannelShortcuts();

function shortcutName(value) { return String(value||"").trim().toLowerCase().replace(/[^a-z0-9_-]/g,""); }
function expandChannelShortcuts(content,guildId) {
  const shortcuts=channelShortcuts[guildId]||{};
  return String(content).replace(/\?m\s+([a-zA-Z0-9_-]+)/gi,(full,raw)=>{
    const id=shortcuts[shortcutName(raw)]; return id ? `<#${id}>` : full;
  });
}

function getMediaOnlyChannelId(guildId) { return channelShortcuts[guildId]?.__mediaOnlyChannelId || null; }
function setMediaOnlyChannel(guildId,channelId) { if(!channelShortcuts[guildId]) channelShortcuts[guildId]={}; channelShortcuts[guildId].__mediaOnlyChannelId=channelId; saveChannelShortcuts(); }
function isAllowedMediaMessage(message) { return message.attachments?.size>0 || message.stickers?.size>0; }
async function enforceMediaOnlyChannel(message) {
  if(!message.guild || message.author?.bot) return false;
  const id=getMediaOnlyChannelId(message.guild.id);
  if(!id || message.channel.id!==id || isAllowedMediaMessage(message)) return false;
  await message.delete().catch(()=>{});
  try {
    const warning=await message.channel.send(`${message.author} ⚠️ **Media-only channel!** Please send an image, GIF, video, sticker, or file.`);
    setTimeout(()=>warning.delete().catch(()=>{}),5000);
  } catch(err) { console.error("Media-only warning error:",err); }
  return true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Channel]
});

client.on("error", err=>console.error("DISCORD CLIENT ERROR:",err));
client.on("warn", warning=>console.warn("DISCORD CLIENT WARNING:",warning));
client.on("shardReconnecting", id=>console.log(`DISCORD SHARD RECONNECTING: shard=${id}`));
client.on("shardResume", (id,replayed)=>console.log(`DISCORD SHARD RESUMED: shard=${id} replayedEvents=${replayed}`));
client.on("invalidated", ()=>console.error("DISCORD SESSION INVALIDATED"));

const commands = [
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member from the server").setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member from the server").setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member to ban").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("progress").setDescription("Show server activity progress"),
  giveawayCommand.data
].map(c=>c.toJSON());

async function deployCommands() {
  const rest=new REST({version:"10"}).setToken(config.token);
  const route=config.guildId ? Routes.applicationGuildCommands(config.clientId,config.guildId) : Routes.applicationCommands(config.clientId);
  await rest.put(route,{body:commands});
  console.log(config.guildId ? "Guild slash commands registered." : "Global slash commands registered.");
}

function formatReportDuration(seconds) {
  seconds=Math.round(Number(seconds)||0); const h=Math.floor(seconds/3600); const m=Math.floor((seconds%3600)/60); const s=seconds%60;
  if(h>0)return `${h}h ${String(m).padStart(2,"0")}m`; if(m>0)return `${m}m ${String(s).padStart(2,"0")}s`; return `${s}s`;
}
async function sendDailyProgressReport(guild,dayKey) {
  const settings=getProgressSettings(guild.id);
  if(!settings.progressViewChannelId || !settings.dailyReportRoleId || wasDailyReportSent(guild.id,dayKey)) return false;
  const channel=guild.channels.cache.get(settings.progressViewChannelId); if(!channel?.isTextBased()) return false;
  const stats=getDayStats(guild.id,dayKey); const images=await getProgressionImages(guild.id,7,dayKey); const role=guild.roles.cache.get(settings.dailyReportRoleId);
  await channel.send({content:[role?`<@&${role.id}>`:"",`📊 **DAILY SERVER REPORT — ${dayKey}**`,"",`💬 **MEMBERS TEXTED:** ${stats.textedMembers}`,`🎙️ **MEMBERS IN VC:** ${stats.vcMembers}`,`💬 **TOTAL MESSAGES:** ${stats.messages.toLocaleString("en-US")}`,`⏱️ **TOTAL VOICE TIME:** ${formatReportDuration(stats.vcSeconds)}`,`👋 **NEW MEMBERS:** ${stats.newMembers}`,`🟢 **PEAK ONLINE:** ${stats.peakOnline}`].filter(Boolean).join("\n")});
  await channel.send({files:[images[0]]}); await channel.send({files:[images[1]]}); markDailyReportSent(guild.id,dayKey); return true;
}
async function runDailyProgressReports(){const day=previousDayKey(); for(const guild of client.guilds.cache.values()){try{await sendDailyProgressReport(guild,day);}catch(err){console.error(`Daily report error for ${guild.id}:`,err);}}}

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

  if (lower === "?lock" || lower === "?unlock") {
    if (!manage) return message.reply("❌ You need **Manage Server** permission.");
    const me = message.guild.members.me;
    if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageChannels)) return message.reply("❌ I need **Manage Channels** permission in this channel.");
    if (!message.channel.permissionOverwrites?.edit) return message.reply("❌ This channel does not support permission locking.");
    const locking = lower === "?lock";
    try {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: locking ? false : null, AddReactions: locking ? false : null,
        CreatePublicThreads: locking ? false : null, CreatePrivateThreads: locking ? false : null, SendMessagesInThreads: locking ? false : null
      }, {reason: locking ? `Channel locked by ${message.author.tag}` : `Channel unlocked by ${message.author.tag}`});
      return message.channel.send(locking ? "🔒 **Channel locked.** Members can read but cannot send messages." : "🔓 **Channel unlocked.**");
    } catch(err) { console.error("Channel lock error:",err); return message.reply("❌ I couldn't change the channel lock. Check **Manage Channels** permission."); }
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
   MESSAGE HANDLER
========================= */
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  if (await specialWelcome.handleMessage(message)) return;
  const content=message.content.trim();
  const lower=content.toLowerCase();

  if (lower === "?setasmedia") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply("❌ You need **Manage Server** permission.");
    setMediaOnlyChannel(message.guild.id,message.channel.id);
    return message.reply("✅ This channel is now **media-only**. Text messages will be deleted and the warning will disappear after 5 seconds.");
  }
  if (await enforceMediaOnlyChannel(message)) return;

  const expanded=expandChannelShortcuts(content,message.guild.id);
  if (expanded !== content) {
    const sent=await message.channel.send({content:expanded,allowedMentions:{parse:[],users:[],roles:[]}}).catch(()=>null);
    if(sent) await message.delete().catch(()=>{});
    return;
  }

  recordMessageActivity(message.guild.id,message.author.id);
  addMessage(message.author.id,message.guild.id,1);
  const activityResult=await handleActivityCommand(message); if(activityResult!==false) return;
  const manageGuild=message.member.permissions.has(PermissionFlagsBits.ManageGuild);

  if (lower === "?commands" || lower === "?help") {
    return message.reply({content: [
      "**🚗 Vehicle Life / LEADER Commands**", "",
      "👋 **Welcome:** `?setspecialwelcomechannel`, `?w`",
      "🛡️ **Moderation:** `?kick`, `?ban`, `?warn`, `?unwarn`, `?warnings`, `?mute`, `?unmute`, `?purge`, `?setnick`, `?giverole`, `?removerole`",
      "🔒 **Channels:** `?lock`, `?unlock`, `?vclock`, `?vcunlock`, `?setasmedia`",
      "📊 **Progress:** `?progress`, `?setdailyreportrole`, `?setasprogressviewchannel`",
      "💬 **Activity:** `?activity help`, `?setmainchannel`",
      "📸 **Instagram:** `?addinsta`, `?removeinsta`, `?insta`",
      "📺 **Shortcuts:** `?setas`, `?removeas`, `?listas`, `?m`",
      "🎁 **Giveaway:** `/giveaway create`"
    ].join("\n")});
  }
  if (lower === "?setdailyreportrole") {
    if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");
    const role=message.mentions.roles.first(); if(!role)return message.reply("❌ Use `?setdailyreportrole @role`");
    setDailyReportRole(message.guild.id,role.id); return message.reply(`✅ Daily report role set to ${role}.`);
  }
  if (lower === "?setasprogressviewchannel") {
    if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");
    setProgressViewChannel(message.guild.id,message.channel.id); return message.reply(`✅ Daily progression reports will be sent in ${message.channel}.`);
  }
  if (lower === "?progress" || /^\?progress\s+\d+$/.test(lower)) {
    let days=Math.min(30,Math.max(2,Number(content.split(/\s+/)[1]||7)));
    try { const stats=getDayStats(message.guild.id); const images=await getProgressionImages(message.guild.id,days); await message.channel.send({content:[`📊 **TODAY'S SERVER PROGRESS — ${stats.key}**`,``,`💬 **MEMBERS TEXTED:** ${stats.textedMembers}`,`🎙️ **MEMBERS IN VC:** ${stats.vcMembers}`,`💬 **TOTAL MESSAGES:** ${stats.messages.toLocaleString("en-US")}`,`⏱️ **TOTAL VOICE TIME:** ${formatReportDuration(stats.vcSeconds)}`,`👋 **NEW MEMBERS:** ${stats.newMembers}`,`🟢 **PEAK ONLINE:** ${stats.peakOnline}`].join("\n")}); await message.channel.send({files:[images[0],images[1]]}); } catch(err){console.error("Progress graph error:",err); return message.reply("❌ I couldn't generate the progression graphs.");} return;
  }

  if (lower.startsWith("?setas ")) {
    if(!manageGuild)return message.reply("❌ You need **Manage Server** permission.");
    const name=shortcutName(content.split(/\s+/)[1]); if(!name)return message.reply("❌ Use `?setas chat`.");
    if(name==="m")return message.reply("❌ `m` is reserved for channel shortcuts.");
    if(!channelShortcuts[message.guild.id])channelShortcuts[message.guild.id]={}; channelShortcuts[message.guild.id][name]=message.channel.id; saveChannelShortcuts();
    return message.reply(`✅ Shortcut **${name}** saved for this channel.`);
  }
  if (lower.startsWith("?removeas")) {
    if(!manageGuild)return message.reply("❌ You need **Manage Server** permission."); const name=shortcutName(content.split(/\s+/)[1]); const g=channelShortcuts[message.guild.id]||{};
    if(!name)return message.reply("❌ Use `?removeas chat`."); if(!g[name])return message.reply("❌ That shortcut is not set."); delete g[name]; saveChannelShortcuts(); return message.reply("✅ Shortcut removed.");
  }
  if (lower === "?listas") {
    if(!manageGuild)return message.reply("❌ You need **Manage Server** permission."); const entries=Object.entries(channelShortcuts[message.guild.id]||{}).filter(([k])=>k!=="__mediaOnlyChannelId");
    return message.reply(entries.length?entries.map(([n,id])=>`• **${n}** → <#${id}>`).join("\n"):"ℹ️ No channel shortcuts are set.");
  }

  if (lower.startsWith("?kick") || lower.startsWith("?ban")) {
    const action=lower.startsWith("?ban")?"ban":"kick", perm=action==="ban"?PermissionFlagsBits.BanMembers:PermissionFlagsBits.KickMembers;
    if(!message.member.permissions.has(perm))return message.reply(`❌ You need **${action==="ban"?"Ban Members":"Kick Members"}** permission.`);
    if(!message.guild.members.me?.permissions.has(perm))return message.reply("❌ I don't have the required permission.");
    const target=message.mentions.members.first(); if(!target)return message.reply("❌ Use ?"+action+" @user [reason].");
    if(target.id===message.author.id||target.id===message.guild.ownerId||target.user.bot)return message.reply("❌ That member cannot be targeted.");
    if(!target.manageable)return message.reply("❌ I cannot moderate that member because of role hierarchy.");
    const reason=content.split(/\s+/).slice(2).join(" ").trim()||`Requested by ${message.author.tag}`;
    try{if(action==="ban")await target.ban({reason});else await target.kick(reason);return message.reply(`✅ ${target.user.tag} was **${action}ed**.\n📝 Reason: ${reason}`);}catch(err){console.error(`${action} error:`,err);return message.reply(`❌ I couldn't ${action} that member.`);}
  }
  if (lower.startsWith("?purge")) {
    if(!message.member.permissions.has(PermissionFlagsBits.ManageMessages))return message.reply("❌ You need **Manage Messages** permission."); const n=Number(content.split(/\s+/)[1]);
    if(!Number.isInteger(n)||n<1||n>100)return message.reply("❌ Usage: `?purge <1-100>`");
    try{const deleted=await message.channel.bulkDelete(n,true);await message.delete().catch(()=>{});const r=await message.channel.send(`🧹 Successfully deleted **${deleted.size}** messages.`);setTimeout(()=>r.delete().catch(()=>{}),3000);}catch(err){console.error("Purge error:",err);return message.reply("❌ I couldn't delete those messages.");} return;
  }
  if (lower === "?warn" || lower.startsWith("?warn ")) {
    if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to warn members.");
    const target=message.mentions.members.first(); if(!target) return message.reply("❌ Please mention a user.");
    if(target.id===message.author.id || target.id===message.guild.ownerId || target.user.bot) return message.reply("❌ That member cannot be warned.");
    if(!target.manageable) return message.reply("❌ I cannot moderate that member because of role hierarchy.");
    const reason=content.split(/\s+/).slice(2).join(" ").trim()||"No reason provided";
    try { const warning=await moderationData.addWarning(message.guild.id,target.id,message.author.id,reason); return message.channel.send(`⚠️ ${target} has been warned.\n🆔 Warning #${warning.id}\n📝 Reason: ${reason}\n📊 Total warnings: ${warning.count}`); }
    catch(err){ console.error("Warn error:",err); return message.reply("❌ Warning storage is not ready. Run `supabase-setup.sql` in Supabase first."); }
  }
  if (lower === "?unwarn" || lower.startsWith("?unwarn ")) {
    if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply("❌ You don't have permission to unwarn members.");
    const target=message.mentions.members.first(); if(!target) return message.reply("❌ Please mention a user.");
    try { const removed=await moderationData.removeLatestWarning(message.guild.id,target.id); return message.channel.send(removed ? `✅ Removed warning #${removed.id} from ${target}.\n📊 Remaining warnings: ${removed.remaining}` : `ℹ️ ${target} has no warnings.`); }
    catch(err){ console.error("Unwarn error:",err); return message.reply("❌ Warning storage is not ready. Run `supabase-setup.sql` in Supabase first."); }
  }
  if (lower === "?warnings" || lower.startsWith("?warnings ")) {
    const target=message.mentions.members.first() || message.member;
    try { const list=await moderationData.listWarnings(message.guild.id,target.id); return message.reply(list.length ? `⚠️ **Warnings for ${target}:**\n${list.slice(-10).map(w=>`#${w.id} — ${w.reason} (<@${w.moderator_id}>)`).join("\n")}` : `✅ ${target} has no warnings.`); }
    catch(err){ console.error("Warnings list error:",err); return message.reply("❌ Warning history could not be loaded."); }
  }
  if (lower.startsWith("?setnick")) {
    if(!message.member.permissions.has(PermissionFlagsBits.ManageNicknames))return message.reply("❌ You don't have permission to change nicknames."); const target=message.mentions.members.first(); const nickname=content.split(/\s+/).slice(2).join(" "); if(!target||!nickname)return message.reply("❌ Use `?setnick @user New Name`.");
    try{await target.setNickname(nickname);return message.channel.send(`✅ Changed ${target}'s nickname to **${nickname}**`);}catch{return message.reply("❌ I can't change that user's nickname.");}
  }
  if (lower.startsWith("?giverole") || lower.startsWith("?removerole")) {
    const adding=lower.startsWith("?giverole"); if(!message.member.permissions.has(PermissionFlagsBits.ManageRoles))return message.reply("❌ You need **Manage Roles** permission."); const target=message.mentions.members.first();
    const role=message.mentions.roles.first()||message.guild.roles.cache.find(r=>r.id===content.split(/\s+/).pop()||r.name.toLowerCase()===content.split(/\s+/).slice(2).join(" ").toLowerCase());
    if(!target||!role)return message.reply("❌ Use the command with a member and role."); if(role.managed||role.position>=message.guild.members.me.roles.highest.position)return message.reply("❌ I can't manage that role.");
    try{if(adding)await target.roles.add(role);else await target.roles.remove(role);return message.channel.send(`✅ ${adding?"Added":"Removed"} **${role.name}** ${adding?"to":"from"} **${target.displayName}**.`);}catch(err){console.error("Role command error:",err);return message.reply("❌ I couldn't update that role.");}
  }
  if (lower.startsWith("?mute") || lower.startsWith("?unmute")) {
    const unmute=lower.startsWith("?unmute"); if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))return message.reply("❌ You need **Moderate Members** permission."); const target=message.mentions.members.first(); if(!target)return message.reply("❌ Please mention a user.");
    if(unmute){try{await target.timeout(null);return message.channel.send(`🔊 ${target} has been unmuted.`);}catch{return message.reply("❌ I can't unmute that user.");}}
    const raw=content.split(/\s+/)[2]||""; const m=raw.match(/^(\d+)(s|m|h|d)$/i); if(!m)return message.reply("❌ Use `?mute @user 5m`."); const mult={s:1000,m:60000,h:3600000,d:86400000}; const ms=Number(m[1])*mult[m[2].toLowerCase()]; if(!Number.isFinite(ms)||ms<=0)return message.reply("❌ Invalid duration.");
    try{await target.timeout(ms);return message.channel.send(`🔇 ${target} has been muted for ${raw}.`);}catch{return message.reply("❌ I can't mute that user.");}
  }
  if (lower.startsWith("?addinsta")) {
    const username=content.split(/\s+/)[1]; if(!username)return message.reply("❌ Please provide an Instagram username."); setInstagram(message.author.id,message.guild.id,username); const role=message.guild.roles.cache.find(r=>r.name==="Instagram user"); if(role)await message.member.roles.add(role).catch(()=>{}); return message.reply(`✅ Instagram username set to ${username}`);
  }
  if (lower.startsWith("?removeinsta")) {
    removeInstagram(message.author.id,message.guild.id); const role=message.guild.roles.cache.find(r=>r.name==="Instagram user"); if(role)await message.member.roles.remove(role).catch(()=>{}); return message.reply("✅ Instagram username removed.");
  }
  if (lower.startsWith("?insta")) {
    const target=message.mentions.users.first()||message.author; const u=getUser(target.id,message.guild.id); return message.reply(u.instagram?`📸 **${target.tag}**: @${u.instagram}`:`ℹ️ No Instagram username is saved for **${target.tag}**.`);
  }
});

/* =========================
   MEMBER / VOICE ACTIVITY
========================= */
client.on("guildMemberAdd", async member=>{if(member.user?.bot)return;recordNewMember(member.guild.id,member.id);updatePeakOnline(member.guild);try{await specialWelcome.notifyNewMember(member);}catch(err){console.error("Welcome error:",err);}});
client.on("guildMemberRemove",member=>updatePeakOnline(member.guild));
client.on("presenceUpdate",(_old,p)=>{if(p?.guild)updatePeakOnline(p.guild);});
client.on("voiceStateUpdate",async(oldState,newState)=>{
  try{
    if(!newState.guild)return; const userId=newState.id,guildId=newState.guild.id,member=newState.member||oldState.member; if(member?.user?.bot)return;
    const joined=!oldState.channelId&&!!newState.channelId, left=!!oldState.channelId&&!newState.channelId;
    if(joined){startVcSession(guildId,userId,Date.now());const u=getUser(userId,guildId);if(u.last_vc_join==null)setVcJoin(userId,guildId,Date.now());return;}
    if(left){endVcSession(guildId,userId,Date.now());settleVcSession(userId,guildId);}
  }catch(err){console.error("voiceStateUpdate error:",err);}
});
client.on("guildMemberUpdate",async(oldMember,newMember)=>{const role=newMember.guild.roles.cache.find(r=>r.name==="Instagram user");if(!role)return;if(oldMember.roles.cache.has(role.id)&&!newMember.roles.cache.has(role.id))removeInstagram(newMember.id,newMember.guild.id);});

/* =========================
   INTERACTIONS
========================= */
client.on("interactionCreate",async interaction=>{
  try{
    if(!interaction.guild)return;
    if(interaction.isButton() && interaction.customId==="giveaway_join"){
      const state=giveawayCommand.giveawayEntries?.get(interaction.message.id); if(!state)return interaction.reply({content:"❌ This giveaway is no longer active.",ephemeral:true});
      if(state.entries.has(interaction.user.id))return interaction.reply({content:"⚠️ You are already entered in this giveaway!",ephemeral:true});
      state.entries.add(interaction.user.id);
      try { await giveawayCommand.saveState(interaction.message.id,state); } catch(err) { state.entries.delete(interaction.user.id); return interaction.reply({content:"❌ Your entry could not be saved. Please try again.",ephemeral:true}); }
      const old=interaction.message.embeds[0]; if(old){const desc=(old.description||"").replace(/👥 \*\*Entries:\*\* \d+/,`👥 **Entries:** ${state.entries.size}`);await interaction.message.edit({embeds:[EmbedBuilder.from(old).setDescription(desc)]}).catch(()=>{});} return interaction.reply({content:"🎉 You have successfully entered this giveaway! Good luck! 🍀",ephemeral:true});
    }
    if(!interaction.isChatInputCommand())return;
    if(interaction.commandName==="giveaway")return await giveawayCommand.execute(interaction);
    await interaction.deferReply();
    if(interaction.commandName==="progress"){
      const stats=getDayStats(interaction.guild.id); const images=await getProgressionImages(interaction.guild.id,7); await interaction.editReply({content:[`📊 **SERVER PROGRESS — ${stats.key}**`,``,`💬 **MEMBERS TEXTED:** ${stats.textedMembers}`,`🎙️ **MEMBERS IN VC:** ${stats.vcMembers}`,`💬 **TOTAL MESSAGES:** ${stats.messages.toLocaleString("en-US")}`,`⏱️ **TOTAL VOICE TIME:** ${formatReportDuration(stats.vcSeconds)}`,`👋 **NEW MEMBERS:** ${stats.newMembers}`,`🟢 **PEAK ONLINE:** ${stats.peakOnline}`].join("\n"),files:[images[0],images[1]]}); return;
    }
    if(interaction.commandName==="kick"||interaction.commandName==="ban"){
      const action=interaction.commandName,perm=action==="ban"?PermissionFlagsBits.BanMembers:PermissionFlagsBits.KickMembers,targetUser=interaction.options.getUser("user",true),target=await interaction.guild.members.fetch(targetUser.id).catch(()=>null),reason=interaction.options.getString("reason")||`Requested by ${interaction.user.tag}`;
      if(!interaction.member.permissions.has(perm))return interaction.editReply(`❌ You need **${action==="ban"?"Ban Members":"Kick Members"}** permission.`); if(!interaction.guild.members.me?.permissions.has(perm))return interaction.editReply("❌ I don't have the required permission."); if(!target)return interaction.editReply("❌ That user is not a member."); if(target.id===interaction.user.id||target.id===interaction.guild.ownerId||target.user.bot)return interaction.editReply("❌ That member cannot be targeted."); if(!target.manageable)return interaction.editReply("❌ I cannot moderate that member because of role hierarchy.");
      if(action==="ban")await target.ban({reason});else await target.kick(reason); return interaction.editReply(`✅ ${targetUser.tag} was **${action}ed**.\n📝 Reason: ${reason}`);
    }
  }catch(err){console.error("Interaction error:",err);if(interaction.isRepliable()&&!interaction.replied&&!interaction.deferred)await interaction.reply({content:"❌ Something went wrong.",ephemeral:true}).catch(()=>{});else if(interaction.deferred)await interaction.editReply("❌ Something went wrong.").catch(()=>{});}
});

async function cleanupOldVoiceLocks() {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
      const everyone = guild.roles.everyone;
      const overwrite = channel.permissionOverwrites.cache.get(everyone.id);
      if (!overwrite || !overwrite.deny.has(PermissionFlagsBits.Connect)) continue;
      if (!guild.members.me?.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
        console.warn(`Cannot remove old VC lock in #${channel.name} (${channel.id}): missing Manage Channels.`);
        continue;
      }
      try {
        await channel.permissionOverwrites.edit(everyone, { Connect: null }, { reason: "Remove obsolete Vehicle Life VC lock feature" });
        console.log(`Removed obsolete VC lock from ${guild.name} / ${channel.name}`);
      } catch (err) {
        console.error(`Failed to remove obsolete VC lock from ${channel.id}:`, err);
      }
    }
  }
}

let dailyTimer=null;
function startDailyLoop(){if(dailyTimer)return;dailyTimer=setInterval(()=>{runDailyProgressReports().catch(err=>console.error("Daily loop error:",err));},15000);dailyTimer.unref?.();}

client.once("clientReady",async()=>{
  console.log(`LEADER READY: Logged in as ${client.user.tag}`);
  try{await deployCommands();}catch(err){console.error("Slash-command registration failed:",err);}
  await cleanupOldVoiceLocks();
  restoreVoiceSessions(client); for(const guild of client.guilds.cache.values())updatePeakOnline(guild); giveawayCommand.init(client).catch(err=>console.error("Giveaway restore failed:",err)); startDailyLoop();
});

async function start(){try{await initDb();await client.login(config.token);}catch(err){console.error("Startup failed:",err);process.exit(1);}}
start();
process.on("unhandledRejection",err=>console.error("Unhandled rejection:",err));
process.on("uncaughtException",err=>console.error("Uncaught exception:",err));
let shuttingDown=false;
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;console.log(`${signal} received. Saving data...`);try{flushProgression();await closeDb();}catch(err){console.error("Shutdown save error:",err);}try{client.destroy();}catch{}try{if(healthServer)await new Promise(r=>healthServer.close(()=>r()));}catch{}if(dailyTimer)clearInterval(dailyTimer);process.exit(0);}
process.on("SIGINT",()=>shutdown("SIGINT")); process.on("SIGTERM",()=>shutdown("SIGTERM"));
