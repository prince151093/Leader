const fs = require("fs");
const path = require("path");

let Canvas;
try {
  Canvas = require("@napi-rs/canvas");
} catch (err) {
  Canvas = null;
}

const DATA_FILE = path.join(__dirname, "progression-data.json");
const TIME_ZONE = process.env.PROGRESSION_TIMEZONE || "Asia/Kolkata";

let data = {};
let saveTimer = null;
let saveInProgress = false;
let saveAgain = false;

function initProgression() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (parsed && typeof parsed === "object") data = parsed;
    }
  } catch (err) {
    console.error("Progression data load error:", err);
    data = {};
  }
}

function saveProgressionNow() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Progression data save error:", err);
  }
}

function saveProgression() {
  if (saveInProgress) {
    saveAgain = true;
    return;
  }

  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveInProgress = true;
    try {
      saveProgressionNow();
    } finally {
      saveInProgress = false;
      if (saveAgain) {
        saveAgain = false;
        saveProgression();
      }
    }
  }, 250);
  saveTimer.unref?.();
}

function flushProgression() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveProgressionNow();
}

function ensureGuild(guildId) {
  if (!data[guildId]) data[guildId] = {};
  const guild = data[guildId];
  if (!guild.days) guild.days = {};
  if (!guild.activeVC) guild.activeVC = {};
  if (!guild.settings) guild.settings = {};
  return guild;
}

function ensureDay(guildId, key) {
  const guild = ensureGuild(guildId);
  if (!guild.days[key]) {
    guild.days[key] = {
      messages: 0,
      vcSeconds: 0,
      textedMembers: [],
      vcMembers: [],
      newMembers: 0,
      peakOnline: 0
    };
  }
  const day = guild.days[key];
  if (!Array.isArray(day.textedMembers)) day.textedMembers = [];
  if (!Array.isArray(day.vcMembers)) day.vcMembers = [];
  if (!Array.isArray(day.newMemberIds)) day.newMemberIds = [];
  if (typeof day.messages !== "number") day.messages = Number(day.messages || 0);
  if (typeof day.vcSeconds !== "number") day.vcSeconds = Number(day.vcSeconds || 0);
  if (typeof day.newMembers !== "number") day.newMembers = Number(day.newMembers || 0);
  if (typeof day.peakOnline !== "number") day.peakOnline = Number(day.peakOnline || 0);
  return day;
}

function dateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

function shiftDateKey(key, deltaDays) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function previousDayKey(ms = Date.now()) {
  return shiftDateKey(dateKey(ms), -1);
}

function addDay(guildId, key, field, amount) {
  const day = ensureDay(guildId, key);
  day[field] = Number(day[field] || 0) + amount;
}

function addUniqueMember(guildId, key, field, userId) {
  const day = ensureDay(guildId, key);
  const id = String(userId);
  if (!day[field].includes(id)) day[field].push(id);
}

function splitSecondsByDay(startMs, endMs, onDay) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

  let cursor = startMs;
  while (cursor < endMs) {
    const key = dateKey(cursor);
    let lo = cursor + 1;
    let hi = cursor + 26 * 60 * 60 * 1000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (dateKey(mid) === key) lo = mid;
      else hi = mid;
    }

    const segmentEnd = Math.min(endMs, hi);
    const seconds = Math.max(0, (segmentEnd - cursor) / 1000);
    if (seconds > 0) onDay(key, seconds);
    cursor = segmentEnd;
  }
}

function recordMessageActivity(guildId, userId) {
  const key = dateKey();
  addDay(guildId, key, "messages", 1);
  if (userId) addUniqueMember(guildId, key, "textedMembers", userId);
  saveProgression();
}

function recordNewMember(guildId, userId) {
  const key = dateKey();
  addDay(guildId, key, "newMembers", 1);
  if (userId) addUniqueMember(guildId, key, "newMemberIds", userId);
  saveProgression();
}

function startVcSession(guildId, userId, startedAt = Date.now()) {
  const guild = ensureGuild(guildId);
  const id = String(userId);
  if (!guild.activeVC[id]) {
    guild.activeVC[id] = startedAt;
    addUniqueMember(guildId, dateKey(startedAt), "vcMembers", id);
    saveProgression();
  }
}

function endVcSession(guildId, userId, endedAt = Date.now()) {
  const guild = ensureGuild(guildId);
  const startedAt = Number(guild.activeVC[userId]);
  if (!startedAt) return;

  splitSecondsByDay(startedAt, endedAt, (key, seconds) => {
    addDay(guildId, key, "vcSeconds", seconds);
  });

  delete guild.activeVC[userId];
  saveProgression();
}

function restoreVoiceSessions(client) {
  for (const guild of client.guilds.cache.values()) {
    const g = ensureGuild(guild.id);
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId) continue;
      if (state.member?.user?.bot) continue;
      if (!g.activeVC[state.id]) {
        g.activeVC[state.id] = Date.now();
        addUniqueMember(guild.id, dateKey(), "vcMembers", state.id);
      }
    }
  }
  saveProgression();
}

function updatePeakOnline(guild) {
  if (!guild) return;
  const online = guild.members.cache.filter(member => {
    if (member.user?.bot) return false;
    const status = member.presence?.status;
    return status === "online" || status === "idle" || status === "dnd";
  }).size;

  const key = dateKey();
  const day = ensureDay(guild.id, key);
  if (online > day.peakOnline) {
    day.peakOnline = online;
    saveProgression();
  }
}

function getSettings(guildId) {
  return ensureGuild(guildId).settings;
}

function setDailyReportRole(guildId, roleId) {
  const settings = getSettings(guildId);
  settings.dailyReportRoleId = roleId;
  saveProgression();
}

function setProgressViewChannel(guildId, channelId) {
  const settings = getSettings(guildId);
  settings.progressViewChannelId = channelId;
  saveProgression();
}

function setTopGaragesChannel(guildId, channelId) {
  const settings = getSettings(guildId);
  settings.topGaragesChannelId = channelId;
  saveProgression();
}

function getProgressSettings(guildId) {
  return { ...getSettings(guildId) };
}

function markDailyReportSent(guildId, dayKey) {
  const settings = getSettings(guildId);
  settings.lastDailyReportKey = dayKey;
  saveProgression();
}

function wasDailyReportSent(guildId, dayKey) {
  return getSettings(guildId).lastDailyReportKey === dayKey;
}

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

function formatDuration(seconds) {
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function lastDays(count, endKey = dateKey()) {
  const result = [];
  for (let i = count - 1; i >= 0; i--) result.push(shiftDateKey(endKey, -i));
  return result;
}

function dayLabel(key) {
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric"
  }).format(d);
}

function renderGraph(title, subtitle, labels, values, formatter, accent) {
  if (!Canvas) throw new Error("Missing @napi-rs/canvas dependency.");

  const width = 1400;
  const height = 820;
  const canvas = Canvas.createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#071426");
  bg.addColorStop(1, "#02060d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#17395f";
  ctx.lineWidth = 2;
  roundRect(ctx, 24, 24, width - 48, height - 48, 28);
  ctx.stroke();

  ctx.fillStyle = "#f4f7ff";
  ctx.font = "700 46px sans-serif";
  ctx.fillText(title, 70, 92);
  ctx.fillStyle = "#8ea6c4";
  ctx.font = "500 23px sans-serif";
  ctx.fillText(subtitle, 72, 132);

  const chart = { x: 100, y: 205, w: 1190, h: 475 };
  const max = Math.max(...values, 1);
  const gridCount = 5;

  for (let i = 0; i <= gridCount; i++) {
    const y = chart.y + chart.h - (chart.h * i / gridCount);
    ctx.strokeStyle = "rgba(111,145,181,0.20)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chart.x, y);
    ctx.lineTo(chart.x + chart.w, y);
    ctx.stroke();

    const v = max * i / gridCount;
    ctx.fillStyle = "#6e86a4";
    ctx.font = "500 18px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(formatter(v), chart.x - 18, y + 6);
  }
  ctx.textAlign = "left";

  const gap = values.length > 14 ? 12 : 28;
  const barW = Math.max(20, (chart.w - gap * (values.length + 1)) / values.length);

  values.forEach((value, i) => {
    const x = chart.x + gap + i * (barW + gap);
    const h = Math.max(value > 0 ? 8 : 0, (value / max) * chart.h);
    const y = chart.y + chart.h - h;

    const grad = ctx.createLinearGradient(0, y, 0, chart.y + chart.h);
    grad.addColorStop(0, accent[0]);
    grad.addColorStop(1, accent[1]);
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, h, Math.min(12, barW / 3));
    ctx.fill();

    ctx.fillStyle = "#eaf2ff";
    ctx.font = values.length > 14 ? "700 14px sans-serif" : "700 18px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(formatter(value), x + barW / 2, Math.max(y - 12, chart.y - 5));

    ctx.fillStyle = "#9ab0ca";
    ctx.font = values.length > 14 ? "600 13px sans-serif" : "600 17px sans-serif";
    ctx.fillText(labels[i], x + barW / 2, chart.y + chart.h + 38);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#617895";
  ctx.font = "500 16px sans-serif";
  ctx.fillText(`Server-wide • ${TIME_ZONE}`, 70, height - 48);

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function getDayStats(guildId, key = dateKey()) {
  const guild = ensureGuild(guildId);
  const day = ensureDay(guildId, key);
  let vcSeconds = Number(day.vcSeconds || 0);
  const now = Date.now();

  for (const startedAt of Object.values(guild.activeVC)) {
    splitSecondsByDay(Number(startedAt), now, (segmentKey, seconds) => {
      if (segmentKey === key) vcSeconds += seconds;
    });
  }

  return {
    key,
    textedMembers: day.textedMembers.length,
    vcMembers: day.vcMembers.length,
    messages: Number(day.messages || 0),
    vcSeconds,
    newMembers: Number(day.newMembers || 0),
    peakOnline: Number(day.peakOnline || 0)
  };
}

async function getProgressionImages(guildId, count = 7, endKey = dateKey()) {
  const guild = ensureGuild(guildId);
  const keys = lastDays(count, endKey);
  const labels = keys.map(dayLabel);
  const messages = keys.map(k => Number(guild.days[k]?.messages || 0));
  const vc = keys.map(k => Number(guild.days[k]?.vcSeconds || 0));

  const now = Date.now();
  const liveVc = {};
  for (const startedAt of Object.values(guild.activeVC)) {
    splitSecondsByDay(Number(startedAt), now, (key, seconds) => {
      liveVc[key] = (liveVc[key] || 0) + seconds;
    });
  }
  const finalVc = keys.map((k, i) => vc[i] + (liveVc[k] || 0));

  const vcBuffer = renderGraph(
    "SERVER VC TIME",
    "Total voice-chat time • all members combined",
    labels,
    finalVc,
    value => formatDuration(value),
    ["#2fd7ff", "#3157ff"]
  );

  const msgBuffer = renderGraph(
    "SERVER MESSAGES",
    "Total messages sent • all members combined",
    labels,
    messages,
    value => formatNumber(value),
    ["#ff72f2", "#7b36ff"]
  );

  return [
    { attachment: vcBuffer, name: "server-vc-time.png" },
    { attachment: msgBuffer, name: "server-messages.png" }
  ];
}

module.exports = {
  initProgression,
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
  setTopGaragesChannel,
  getProgressSettings,
  markDailyReportSent,
  wasDailyReportSent,
  dateKey,
  previousDayKey,
  TIME_ZONE
};
