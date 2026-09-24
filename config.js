require("dotenv").config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
};
