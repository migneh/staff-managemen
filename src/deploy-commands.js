'use strict';
const { REST, Routes } = require('discord.js');
const config = require('./config');
const { commands } = require('./commands');

(async () => {
  if (!config.token || !config.clientId || !config.guildId) {
    console.error('❌ تأكد من DISCORD_TOKEN و CLIENT_ID و GUILD_ID في .env');
    process.exit(1);
  }
  const body = [...commands.values()].map(c => c.data.toJSON());
  const rest = new REST().setToken(config.token);
  console.log(`🚀 تسجيل ${body.length} أمر في السيرفر ${config.guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log('✅ تم تسجيل الأوامر:', body.map(c => `/${c.name}`).join(' '));
})().catch(e => { console.error(e); process.exit(1); });
