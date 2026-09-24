const { PermissionFlagsBits } = require("discord.js");

module.exports = {
    name: "purge",

    async execute(message, args) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply("❌ You need **Manage Messages** permission to use this command.");
        }

        const amount = parseInt(args[0]);

        if (!amount || amount < 1 || amount > 100) {
            return message.reply("❌ Use: `?purge <1-100>`");
        }

        const deleted = await message.channel.bulkDelete(amount + 1, true);

        const reply = await message.channel.send(
            `🧹 Successfully deleted **${Math.max(deleted.size - 1, 0)}** messages.`
        );

        setTimeout(() => {
            reply.delete().catch(() => {});
        }, 3000);
    }
};


