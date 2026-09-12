'use strict';
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const config = require('./config');
const { getDb } = require('./database');
const { commands, resolveComponent } = require('./commands');
const { resolveStaff, LEVEL_LABELS } = require('./services/permissions');
const staffService = require('./services/staff');
const activity = require('./services/activity');
const scheduler = require('./scheduler');
const { replyEphemeral, COLORS, log } = require('./utils');
const { TEAMS } = require('./constants');

if (!config.token) { console.error('❌ DISCORD_TOKEN غير موجود في .env'); process.exit(1); }

getDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ ${c.user.tag} جاهز — Staff Manager Bot`);
  scheduler.start(client);
});

// ===== تتبع النشاط التلقائي =====
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild || msg.guild.id !== config.guildId) return;
    const info = resolveStaff(msg.member);
    if (!info) return;
    const s = staffService.ensure(msg.member);
    if (s?.isNew) await log(client, '🆕 إداري جديد', `<@${msg.author.id}> — ${s.rank} (${TEAMS[s.team]}) — تم تسجيله تلقائياً بحالة تجريبية.`, COLORS.success);
    staffService.touchActivity(msg.author.id);
    activity.record(msg.author.id, msg.channel, msg.content);
  } catch (e) { console.error('خطأ في تتبع النشاط:', e); }
});

// ===== تحديث الرتبة عند تغيير رتب الديسكورد =====
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  try { if (newM.guild.id === config.guildId && staffService.get(newM.id) && resolveStaff(newM)) staffService.ensure(newM); } catch (e) { console.error(e); }
});

// ===== الأوامر والمكونات =====
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.inGuild() || i.guildId !== config.guildId) return;
    const info = resolveStaff(i.member);
    if (!info) return replyEphemeral(i, '❌ هذا البوت مخصص للإداريين فقط.', COLORS.danger);
    staffService.ensure(i.member);
    i.staffInfo = info;
    i.staffLevel = info.level;

    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (!cmd) return;
      if (info.level < cmd.level) return replyEphemeral(i, `❌ هذا الأمر متاح لـ **${LEVEL_LABELS[cmd.level]}**.`, COLORS.danger);
      if (cmd.maxLevel && info.level > cmd.maxLevel) return replyEphemeral(i, '❌ هذا الأمر غير متاح لرتبتك.', COLORS.danger);
      if (cmd.team && info.team !== cmd.team) return replyEphemeral(i, `❌ هذا الأمر خاص بـ **${TEAMS[cmd.team]}**.`, COLORS.danger);
      const s = staffService.get(i.user.id);
      if (s?.status === 'suspended' && !['my-record', 'my-performance', 'faq', 'faq-list', 'resign'].includes(i.commandName)) return replyEphemeral(i, '⛔ حسابك الإداري موقوف حالياً.', COLORS.danger);
      return await cmd.execute(i);
    }

    if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) {
      const r = resolveComponent(i.customId);
      if (!r) return;
      return await r.handler(i, r.args);
    }
  } catch (e) {
    console.error(`خطأ في التفاعل ${i.commandName || i.customId}:`, e);
    try { await replyEphemeral(i, '❌ حدث خطأ غير متوقع. تم تسجيله.', COLORS.danger); } catch {}
  }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
client.login(config.token);
