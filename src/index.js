'use strict';
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { getDb } = require('./database');
const { commands, resolveComponent } = require('./commands');
const { resolveStaff, LEVEL_LABELS, isServerManager } = require('./services/permissions');
const staffService = require('./services/staff');
const activity = require('./services/activity');
const ticketLogs = require('./services/ticketLogs');
const audit = require('./services/audit');
const scheduler = require('./scheduler');
const settings = require('./services/settings');
const { deployCommands } = require('./deploy-commands');
const { replyEphemeral, COLORS, log, embed, sendToChannel } = require('./utils');
const { TEAMS, LEVELS } = require('./constants');

if (!config.token) { console.error('❌ DISCORD_TOKEN غير موجود في .env'); process.exit(1); }
if (!config.guildId) { console.error('❌ GUILD_ID غير موجود في .env'); process.exit(1); }

getDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ ${c.user.tag} جاهز — Staff Manager Bot`);

  // تسجيل أوامر السلاش تلقائياً عند كل تشغيل.
  if (process.env.SKIP_DEPLOY !== 'true') {
    try {
      if (!config.clientId) config.clientId = c.user.id;
      await deployCommands();
    } catch (e) { console.error('❌ فشل تسجيل الأوامر:', e.message); }
  }

  const st = settings.status();
  if (!st.complete) console.log(`⚙️  الإعداد غير مكتمل (رتب ${st.rolesDone}/${st.rolesTotal} • قنوات ${st.channelsDone}/${st.channelsTotal}) — استخدم /setup داخل السيرفر.`);
  if (!st.ticketSourceConfigured) console.log('🎫 التسجيل التلقائي للتكتات غير مفعل — حدد قناة سجل البوت الخارجي من /setup.');
  scheduler.start(client);
});

// ===== قراءة سجل التكتات من قناة البوت الخارجي =====
async function importExternalTicketLog(msg) {
  if (msg.author?.id === client.user?.id) return;
  const parsed = ticketLogs.parseExternalTicketMessage(msg);
  if (!parsed) return false;
  const result = ticketLogs.recordTicket(parsed);
  if (result.duplicate) return true;

  audit.record({
    action: 'ticket_auto_logged', actorId: parsed.loggedBy, targetId: parsed.claimer,
    details: { ticketId: parsed.ticketId, sourceMessageId: parsed.sourceMessageId, rowId: result.row.id, reopened: result.reopened },
    channelId: msg.channelId,
  });

  const e = embed(`🎫 تم تسجيل التكت تلقائياً ${result.reopened ? '♻️' : '✅'}`,
    `تمت قراءة سجل **${parsed.ticketId}** من البوت الخارجي بدون تدخل يدوي.\n\n👤 المستلم: <@${parsed.claimer}>\n🔒 الذي أغلقه: <@${parsed.closer}>\n🎯 النقاط: **${result.earned >= 0 ? '+' : ''}${result.earned}**\n🔗 [فتح سجل التكت](${parsed.ticketUrl || parsed.sourceUrl || msg.url})`,
    result.reopened ? COLORS.warning : COLORS.success).setFooter({ text: `السجل #${result.row.id} • المصدر: ${msg.author.tag || msg.author.id}` });
  await sendToChannel(client, 'ticket-logs', { embeds: [e] });
  return true;
}

// ===== تتبع النشاط التلقائي + استيراد سجل التكتات =====
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild || msg.guild.id !== config.guildId) return;
    if (msg.author.bot) {
      await importExternalTicketLog(msg);
      return;
    }
    const info = resolveStaff(msg.member);
    if (!info) return;
    const s = staffService.ensure(msg.member);
    if (s?.isNew) await log(client, '🆕 إداري جديد', `<@${msg.author.id}> — ${s.rank} (${TEAMS[s.team]}) — تم تسجيله تلقائياً${s.status === 'probation' ? ' بحالة تجريبية' : ''}.`, COLORS.success);
    staffService.touchActivity(msg.author.id);
    activity.record(msg.author.id, msg.channel, msg.content);
  } catch (e) { console.error('خطأ في تتبع الرسالة:', e); }
});

// ===== تحديث الرتبة عند تغيير رتب الديسكورد =====
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  try {
    if (newM.guild.id === config.guildId && (staffService.get(newM.id) || resolveStaff(newM))) {
      const info = resolveStaff(newM);
      if (info) staffService.ensure(newM);
    }
  } catch (e) { console.error('خطأ في مزامنة الرتبة:', e); }
});

// ===== الأوامر والمكونات =====
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.inGuild() || i.guildId !== config.guildId) return;

    const isAdmin = i.member.permissions.has(PermissionFlagsBits.Administrator);
    const serverManager = isServerManager(i.member);
    const isSetup = (i.isChatInputCommand() && i.commandName === 'setup') || (i.customId && i.customId.startsWith('setup:'));
    let info = null;

    if (isSetup) {
      if (!isAdmin) return replyEphemeral(i, '❌ الإعداد متاح لمن يملك صلاحية **Administrator** فقط.', COLORS.danger);
    } else {
      info = resolveStaff(i.member);
      if (!info && !serverManager) {
        const st = settings.status();
        if (!st.anyRole && isAdmin) return replyEphemeral(i, '👋 **أهلاً!** البوت لم يُعدّ بعد.\nاستخدم **`/setup`** لتحديد الرتب والقنوات بقوائم اختيار سهلة (دقيقتان).', COLORS.warning);
        return replyEphemeral(i, '❌ هذا البوت مخصص للإداريين فقط.', COLORS.danger);
      }
      if (info) {
        staffService.ensure(i.member);
        i.staffInfo = info;
        i.staffLevel = info.level;
      } else {
        // مالك السيرفر/Server Manager يمكنه استعمال أوامر الإدارة المخصصة حتى دون رتبة فريق.
        i.staffLevel = LEVELS.GENERAL_MANAGER;
      }
    }

    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (!cmd) return;
      if (isSetup) return await cmd.execute(i);
      if (cmd.serverManagerOnly && !serverManager) return replyEphemeral(i, '❌ هذا الأمر متاح لـ **Server Manager** أو **General Manager** الحالي فقط.', COLORS.danger);
      const effectiveLevel = i.staffLevel || (serverManager ? 7 : 0);
      if (effectiveLevel < (cmd.level || 0)) return replyEphemeral(i, `❌ هذا الأمر متاح لـ **${LEVEL_LABELS[cmd.level] || 'إدارة أعلى'}**.`, COLORS.danger);
      if (cmd.maxLevel && effectiveLevel > cmd.maxLevel) return replyEphemeral(i, '❌ هذا الأمر غير متاح لرتبتك.', COLORS.danger);
      if (cmd.team && info?.team !== cmd.team) return replyEphemeral(i, `❌ هذا الأمر خاص بـ **${TEAMS[cmd.team]}**.`, COLORS.danger);
      const s = staffService.get(i.user.id);
      if (s?.status === 'suspended' && !['my-record', 'my-performance', 'faq', 'faq-list', 'resign', 'help', 'me', 'my-tasks'].includes(i.commandName)) {
        return replyEphemeral(i, '⛔ حسابك الإداري موقوف حالياً.', COLORS.danger);
      }
      return await cmd.execute(i);
    }

    if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
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
