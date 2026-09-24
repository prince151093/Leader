const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require("discord.js");

const giveawayEntries = new Map();
const giveawayTimers = new Map();

function parseDuration(input) {
  const match = String(input || "").trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };

  const ms = amount * multipliers[unit];
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return ms;
}

function formatDuration(ms) {
  let seconds = Math.floor(ms / 1000);
  const weeks = Math.floor(seconds / 604800);
  seconds %= 604800;
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];
  if (weeks) parts.push(`${weeks}w`);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
}

async function finishGiveaway(messageId, client) {
  const state = giveawayEntries.get(messageId);
  if (!state) return;

  giveawayEntries.delete(messageId);
  const timer = giveawayTimers.get(messageId);
  if (timer) clearTimeout(timer);
  giveawayTimers.delete(messageId);

  try {
    const message = await client.channels.fetch(state.channelId).then(channel =>
      channel.messages.fetch(messageId)
    );

    const entries = [...state.entries];
    const winnersCount = Math.min(state.winners, entries.length);
    const winners = [];

    while (winners.length < winnersCount) {
      const index = Math.floor(Math.random() * entries.length);
      const [winner] = entries.splice(index, 1);
      winners.push(winner);
    }

    const winnerText = winners.length
      ? winners.map(id => `<@${id}>`).join(", ")
      : "No valid entries.";

    const oldEmbed = message.embeds[0];
    const endedEmbed = oldEmbed
      ? EmbedBuilder.from(oldEmbed)
          .setTitle(`🎁 ${state.prize} — ENDED`)
          .setDescription(
            `## 🎉 Giveaway Ended!\n\n` +
            `🎁 **Prize:** ${state.prize}\n` +
            `🏆 **Winners:** ${state.winners}\n` +
            `👥 **Entries:** ${state.entries.size}\n\n` +
            `🥳 **Winner(s):** ${winnerText}`
          )
          .setFooter({ text: "Vehicle Life • Giveaway ended" })
          .setTimestamp()
      : new EmbedBuilder()
          .setTitle(`🎁 ${state.prize} — ENDED`)
          .setDescription(`🥳 **Winner(s):** ${winnerText}`)
          .setTimestamp();

    await message.edit({ embeds: [endedEmbed], components: [] });
  } catch (err) {
    console.error("Giveaway finish error:", err.message);
  }
}

module.exports = {
  giveawayEntries,
  data: new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Create a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName("create")
        .setDescription("Create a giveaway")
        .addStringOption(option =>
          option
            .setName("prize")
            .setDescription("Giveaway prize")
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName("duration")
            .setDescription("Example: 1h, 24h, 7d")
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName("winners")
            .setDescription("Number of winners")
            .setMinValue(1)
            .setMaxValue(20)
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const prize = interaction.options.getString("prize");
    const duration = interaction.options.getString("duration");
    const winners = interaction.options.getInteger("winners");
    const durationMs = parseDuration(duration);

    if (!durationMs) {
      return interaction.reply({
        content: "❌ Invalid duration. Use values like `30s`, `10m`, `1h`, `24h`, or `7d`.",
        ephemeral: true
      });
    }

    const endsAt = Date.now() + durationMs;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🎁 ${prize}`)
      .setDescription(
        "## 🎉 Giveaway is Live!\n\n" +
        "Click the button below to enter!\n\n" +
        `🎁 **Prize:** ${prize}\n` +
        `🏆 **Winners:** ${winners}\n` +
        `⏱️ **Duration:** ${formatDuration(durationMs)}\n` +
        `⏰ **Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n\n` +
        "👥 **Entries:** 0"
      )
      .setFooter({ text: "Vehicle Life • Good luck! 🍀" })
      .setTimestamp();

    const button = new ButtonBuilder()
      .setCustomId("giveaway_join")
      .setLabel("🎉 Join Giveaway")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row] });
    const giveawayMessage = await interaction.fetchReply();

    giveawayEntries.set(giveawayMessage.id, {
      entries: new Set(),
      prize,
      winners,
      channelId: interaction.channelId,
      endsAt
    });

    const timer = setTimeout(() => {
      finishGiveaway(giveawayMessage.id, interaction.client);
    }, durationMs);

    giveawayTimers.set(giveawayMessage.id, timer);
  }
};
