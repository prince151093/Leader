const { createClient } = require('@supabase/supabase-js');
const config = require('../../config');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth:{persistSession:false,autoRefreshToken:false} });
const giveawayEntries = new Map();
const giveawayTimers = new Map();

function parseDuration(input){const m=String(input||'').trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);if(!m)return null;const n=Number(m[1]),u=m[2].toLowerCase(),x={s:1000,m:60000,h:3600000,d:86400000,w:604800000}[u];const ms=n*x;return Number.isSafeInteger(ms)&&ms>0?ms:null;}
function formatDuration(ms){let s=Math.floor(ms/1000),w=Math.floor(s/604800);s%=604800;let d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);s%=60;const a=[];if(w)a.push(`${w}w`);if(d)a.push(`${d}d`);if(h)a.push(`${h}h`);if(m)a.push(`${m}m`);if(s||!a.length)a.push(`${s}s`);return a.join(' ');}
async function saveState(messageId,state){const row={message_id:String(messageId),guild_id:String(state.guildId),channel_id:String(state.channelId),prize:state.prize,winners:state.winners,ends_at:state.endsAt,entries:[...state.entries],winner_ids:Array.isArray(state.winnerIds)?state.winnerIds:null};const {error}=await supabase.from('giveaways').upsert(row,{onConflict:'message_id'});if(error)throw error;}
async function deleteState(messageId){const {error}=await supabase.from('giveaways').delete().eq('message_id',String(messageId));if(error)throw error;}
async function finishGiveaway(messageId,client){
  const id=String(messageId),state=giveawayEntries.get(id);
  if(!state || state.finishing) return;
  state.finishing=true;
  try {
    const channel=await client.channels.fetch(state.channelId);
    if(!channel?.messages) throw new Error('Giveaway channel is unavailable');
    const message=await channel.messages.fetch(id);
    if (!Array.isArray(state.winnerIds)) {
      const pool=[...state.entries],winners=[];
      while(winners.length<Math.min(state.winners,pool.length)) winners.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]);
      state.winnerIds=winners;
      await saveState(id,state); // Freeze the result before editing Discord, so retries never reroll.
    }
    const winnerText=state.winnerIds.length?state.winnerIds.map(uid=>`<@${uid}>`).join(', '):'No valid entries.';
    const old=message.embeds[0];
    const embed=old?EmbedBuilder.from(old).setTitle(`🎁 ${state.prize} — ENDED`).setDescription(`## 🎉 Giveaway Ended!\n\n🎁 **Prize:** ${state.prize}\n🏆 **Winners:** ${state.winners}\n👥 **Entries:** ${state.entries.size}\n\n🥳 **Winner(s):** ${winnerText}`).setFooter({text:'LEADER • Giveaway ended'}).setTimestamp():new EmbedBuilder().setTitle(`🎁 ${state.prize} — ENDED`).setDescription(`🥳 **Winner(s):** ${winnerText}`).setTimestamp();
    await message.edit({embeds:[embed],components:[]});
    await deleteState(id);
    giveawayEntries.delete(id);
    state.finishing=false;
  } catch(err) {
    state.finishing=false;
    console.error('Giveaway finish error; persistent state retained:',err.message);
    const retry=setTimeout(()=>finishGiveaway(id,client),60_000); retry.unref?.();
  } finally {
    if(!state.finishing){const t=giveawayTimers.get(id);if(t)clearTimeout(t);giveawayTimers.delete(id);}
  }
}
function schedule(messageId,client,endsAt){const id=String(messageId),remaining=Math.max(0,Number(endsAt)-Date.now()),delay=Math.min(remaining,2147483647);const timer=setTimeout(()=>{if(Date.now()<Number(endsAt))schedule(id,client,endsAt);else finishGiveaway(id,client);},delay);timer.unref?.();const previous=giveawayTimers.get(id);if(previous)clearTimeout(previous);giveawayTimers.set(id,timer);}
async function init(client){const {data,error}=await supabase.from('giveaways').select('*');if(error){console.error('Giveaway restore error:',error.message);return;}for(const row of data||[]){const id=String(row.message_id),state={guildId:String(row.guild_id),channelId:String(row.channel_id),prize:row.prize,winners:Number(row.winners),endsAt:Number(row.ends_at),entries:new Set(Array.isArray(row.entries)?row.entries:[]),winnerIds:Array.isArray(row.winner_ids)?row.winner_ids:undefined,finishing:false};giveawayEntries.set(id,state);if(state.endsAt<=Date.now()) await finishGiveaway(id,client); else schedule(id,client,state.endsAt);}console.log(`Restored ${giveawayEntries.size} active giveaway(s).`);}

module.exports={giveawayEntries,init,saveState,data:new SlashCommandBuilder().setName('giveaway').setDescription('Create a giveaway').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addSubcommand(sub=>sub.setName('create').setDescription('Create a giveaway').addStringOption(o=>o.setName('prize').setDescription('Giveaway prize').setRequired(true)).addStringOption(o=>o.setName('duration').setDescription('Example: 1h, 24h, 7d').setRequired(true)).addIntegerOption(o=>o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20).setRequired(true))),
async execute(interaction){const prize=interaction.options.getString('prize'),duration=interaction.options.getString('duration'),winners=interaction.options.getInteger('winners'),durationMs=parseDuration(duration);if(!durationMs)return interaction.reply({content:'❌ Invalid duration. Use `30s`, `10m`, `1h`, `24h`, or `7d`.',ephemeral:true});const endsAt=Date.now()+durationMs;const embed=new EmbedBuilder().setColor(0x5865F2).setTitle(`🎁 ${prize}`).setDescription(`## 🎉 Giveaway is Live!\n\nClick the button below to enter!\n\n🎁 **Prize:** ${prize}\n🏆 **Winners:** ${winners}\n⏱️ **Duration:** ${formatDuration(durationMs)}\n⏰ **Ends:** <t:${Math.floor(endsAt/1000)}:R>\n\n👥 **Entries:** 0`).setFooter({text:'LEADER • Good luck! 🍀'}).setTimestamp();const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway_join').setLabel('🎉 Join Giveaway').setStyle(ButtonStyle.Success));await interaction.reply({embeds:[embed],components:[row]});const msg=await interaction.fetchReply();const state={guildId:interaction.guildId,channelId:interaction.channelId,prize,winners,endsAt,entries:new Set(),finishing:false};giveawayEntries.set(msg.id,state);try{await saveState(msg.id,state);}catch(err){giveawayEntries.delete(msg.id);await msg.edit({content:'❌ Giveaway could not be saved. Check that the `giveaways` table from `supabase-settings-setup.sql` exists.',components:[]}).catch(()=>{});return;}schedule(msg.id,interaction.client,endsAt);}}
