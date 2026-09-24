const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const CONFIG_FILE = path.join(__dirname, 'special-welcome-config.json');
const TEMPLATE_FILE = path.join(__dirname, 'assets', 'special-welcome-template.png');

// The uploaded VR template is 1354x698. These boxes intentionally stay inside
// the existing artwork: only the two avatar circles, two name plates and the
// empty center area are drawn over.
const LAYOUT = {
  leftAvatar: { x: 177, y: 300, r: 128 },
  rightAvatar: { x: 1153, y: 300, r: 128 },
  // Text-safe areas are INSIDE the actual neon name plates. Nothing is
  // allowed to render outside these bounds, even with very long/stylized names.
  leftName: { x: 125, y: 497, width: 235, maxSize: 31 },
  rightName: { x: 1055, y: 497, width: 250, maxSize: 31 },
  center: { x: 677, y: 410, width: 535, maxSize: 54 }
  // Avatar circles and text areas are also hard-clipped below.

};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    console.error('Special welcome config load error:', err);
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getChannelId(guildId) {
  return loadConfig()[guildId]?.channelId || null;
}

function setChannelId(guildId, channelId) {
  const config = loadConfig();
  config[guildId] = { channelId };
  saveConfig(config);
}

function fitFont(ctx, text, maxWidth, startSize, minSize = 16, weight = 700) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px "Noto Sans", "DejaVu Sans", sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Avatar download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function drawAvatar(ctx, avatarBuffer, circle) {
  const image = await loadImage(avatarBuffer);
  const diameter = circle.r * 2;

  const scale = Math.max(diameter / image.width, diameter / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = circle.x - width / 2;
  const y = circle.y - height / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(image, x, y, width, height);
  ctx.restore();
}

function drawCenteredText(ctx, text, x, y, maxWidth, startSize) {
  const size = fitFont(ctx, text, maxWidth, startSize, 18, 800);
  ctx.font = `800 ${size}px "Noto Sans", "DejaVu Sans", sans-serif`;
  const safeText = ellipsizeToFit(ctx, text, maxWidth);

  ctx.save();
  // Hard horizontal lock for center text as well.
  ctx.beginPath();
  ctx.rect(x - maxWidth / 2, y - size, maxWidth, size * 2);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 7;
  ctx.fillText(safeText, x, y);
  ctx.restore();
}

function ellipsizeToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = '…';
  let value = String(text);
  while (value.length > 1 && ctx.measureText(value + suffix).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return value + suffix;
}

function drawClippedText(ctx, text, box, align = 'center') {
  const clean = String(text || '').trim() || 'Member';
  let size = fitFont(ctx, clean, box.width, box.maxSize, 12, 700);
  ctx.font = `700 ${size}px "Noto Sans", "DejaVu Sans", sans-serif`;
  const safeText = ellipsizeToFit(ctx, clean, box.width);

  ctx.save();
  // HARD LOCK: pixels from this text operation cannot leave the name plate.
  ctx.beginPath();
  ctx.rect(box.x, box.y - box.height / 2, box.width, box.height);
  ctx.clip();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 5;
  ctx.fillText(safeText, box.textX, box.textY);
  ctx.restore();
}

function drawName(ctx, text, box, align) {
  drawClippedText(ctx, text, box, align);
}

async function renderWelcome(commandUser, newMember) {
  if (!fs.existsSync(TEMPLATE_FILE)) {
    throw new Error(`Missing special welcome template: ${TEMPLATE_FILE}`);
  }

  const template = await loadImage(TEMPLATE_FILE);
  const canvas = createCanvas(template.width, template.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0, template.width, template.height);

  const commandAvatar = await fetchBuffer(
    commandUser.displayAvatarURL({ extension: 'png', size: 256, forceStatic: false })
  );
  const memberAvatar = await fetchBuffer(
    newMember.displayAvatarURL({ extension: 'png', size: 256, forceStatic: false })
  );

  await drawAvatar(ctx, commandAvatar, LAYOUT.leftAvatar);
  await drawAvatar(ctx, memberAvatar, LAYOUT.rightAvatar);

  // Name text is locked inside the two plate borders. The Discord logos are
  // outside these safe areas, so a long name can never overwrite them.
  drawName(ctx, `@${commandUser.displayName}`, {
    ...LAYOUT.leftName,
    height: 52,
    textX: LAYOUT.leftName.x + LAYOUT.leftName.width / 2,
    textY: LAYOUT.leftName.y
  }, 'center');
  drawName(ctx, `@${newMember.displayName}`, {
    ...LAYOUT.rightName,
    height: 52,
    textX: LAYOUT.rightName.x + LAYOUT.rightName.width / 2,
    textY: LAYOUT.rightName.y
  }, 'center');

  // Center copy is also constrained to its own text area.
  drawCenteredText(ctx, `@${newMember.displayName}`, LAYOUT.center.x, 327, LAYOUT.center.width, 42);
  drawCenteredText(ctx, 'WELCOME', LAYOUT.center.x, 387, LAYOUT.center.width, 56);
  drawCenteredText(ctx, `I AM @${commandUser.displayName}`, LAYOUT.center.x, 448, LAYOUT.center.width, 38);

  return canvas.toBuffer('image/png');
}

function getGender(member) {
  const maleRoleId = process.env.SPECIAL_WELCOME_MALE_ROLE_ID;
  const femaleRoleId = process.env.SPECIAL_WELCOME_FEMALE_ROLE_ID;

  if (maleRoleId && member.roles.cache.has(maleRoleId)) return 'male';
  if (femaleRoleId && member.roles.cache.has(femaleRoleId)) return 'female';

  const roles = member.roles.cache.filter(role => role.id !== member.guild.id);
  if (roles.some(role => /^(male|man|boy|he|him)$/i.test(role.name.trim()))) return 'male';
  if (roles.some(role => /^(female|woman|girl|she|her)$/i.test(role.name.trim()))) return 'female';

  return null;
}

async function notifyNewMember(member) {
  if (!member?.guild || member.user?.bot) return false;

  const channelId = getChannelId(member.guild.id);
  if (!channelId) return false;

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const gender = getGender(member);
  const pronoun = gender === 'male' ? 'HIM' : gender === 'female' ? 'HER' : 'THEM';
  const line = `🎉 **A NEW MEMBER JUST JOINED THE SERVER!**\nYou can welcome **${pronoun}** using \`?w\``;

  await channel.send({ content: line }).catch(err => {
    console.error('Special welcome join notification error:', err);
  });
  return true;
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return false;

  const content = message.content.trim();
  const lower = content.toLowerCase();

  if (lower === '?setspecialwelcomechannel') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('❌ You need **Manage Server** permission to set the special welcome channel.');
      return true;
    }
    if (!message.channel.isTextBased()) {
      await message.reply('❌ This channel cannot be used for special welcomes.');
      return true;
    }
    setChannelId(message.guild.id, message.channel.id);
    await message.reply(`✅ Special welcome channel set to ${message.channel}.`);
    return true;
  }

  if (lower === '?w' || lower.startsWith('?w ')) {
    if (lower !== '?w') {
      await message.reply('❌ Use `?w` without any arguments.');
      return true;
    }

    const configuredChannelId = getChannelId(message.guild.id);
    if (!configuredChannelId) {
      await message.reply('❌ Special welcome channel is not set. Use `?setspecialwelcomechannel` first.');
      return true;
    }

    if (message.channel.id !== configuredChannelId) {
      await message.reply(`❌ Use \`?w\` only in <#${configuredChannelId}>.`);
      return true;
    }

    await message.guild.members.fetch().catch(() => null);
    const members = [...message.guild.members.cache.values()]
      .filter(member => !member.user.bot && member.joinedTimestamp)
      .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
    const newMember = members[0];

    if (!newMember) {
      await message.reply('❌ I could not find a joined member to welcome.');
      return true;
    }

    try {
      const image = await renderWelcome(message.member, newMember);
      const attachment = new AttachmentBuilder(image, { name: 'vehicle-life-welcome.png' });
      const text = `${newMember} WELCOME FROM ${message.member} FOR JOINING US LET'S DO FUN TOGETHER`;
      await message.channel.send({ content: text, files: [attachment] });
    } catch (err) {
      console.error('Special welcome render error:', err);
      await message.reply('❌ I could not generate the welcome banner. Please check the bot logs.');
    }
    return true;
  }

  return false;
}

module.exports = {
  handleMessage,
  notifyNewMember,
  getGender,
  getChannelId,
  setChannelId
};

