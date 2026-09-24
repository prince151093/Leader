const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession:false, autoRefreshToken:false } });

async function addWarning(guildId, userId, moderatorId, reason) {
  const { data, error } = await supabase.from('warnings').insert({guild_id:String(guildId), user_id:String(userId), moderator_id:String(moderatorId), reason:String(reason).slice(0,1000)}).select('id,reason,moderator_id,created_at').single();
  if(error) throw error;
  const { count, error: countError } = await supabase.from('warnings').select('id',{count:'exact',head:true}).eq('guild_id',String(guildId)).eq('user_id',String(userId));
  if(countError) throw countError;
  return {...data,count:count||1};
}
async function listWarnings(guildId,userId){
  const {data,error}=await supabase.from('warnings').select('id,reason,moderator_id,created_at').eq('guild_id',String(guildId)).eq('user_id',String(userId)).order('id',{ascending:true});
  if(error) throw error; return data||[];
}
async function removeLatestWarning(guildId,userId){
  const list=await listWarnings(guildId,userId); if(!list.length)return null;
  const latest=list[list.length-1]; const {error}=await supabase.from('warnings').delete().eq('id',latest.id); if(error)throw error;
  return {id:latest.id,remaining:list.length-1};
}
module.exports={addWarning,listWarnings,removeLatestWarning};
