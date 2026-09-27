'use strict';
const { REST, Routes } = require('discord.js');
const config = require('./config');
const { commands } = require('./commands');

/** تسجيل أوامر السلاش في السيرفر. يُستدعى تلقائياً من index.js عند التشغيل. */
async function deployCommands() {
  if (!config.token || !config.clientId || !config.guildId) throw new Error('تأكد من DISCORD_TOKEN و CLIENT_ID و GUILD_ID في .env');
  const body = [...commands.values()].map(c => c.data.toJSON());
  const rest = new REST().setToken(config.token);
  console.log(`🚀 تسجيل ${body.length} أمر في السيرفر ${config.guildId}...`);
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body }
  );

  // Discord يعيد القائمة التي حفظها فعلياً؛ لا نعلن النجاح إذا أسقط أمراً.
  const registeredNames = new Set(registered.map(command => command.name));
  const missing = body.map(command => command.name).filter(name => !registeredNames.has(name));
  if (missing.length) {
    throw new Error(`لم يسجّل Discord الأوامر التالية: ${missing.map(name => `/${name}`).join(' ')}`);
  }

  console.log(`✅ تم تسجيل وتأكيد ${registered.length} أمر:`, body.map(c => `/${c.name}`).join(' '));
  return registered.length;
}

module.exports = { deployCommands };

if (require.main === module) {
  deployCommands().catch(e => { console.error('❌', e.message); process.exit(1); });
}
