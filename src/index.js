'use strict';
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { getDb } = require('./database');
const { commands, resolveComponent, validateRegistry } = require('./commands');
const { resolveStaff, LEVEL_LABELS, isServerManager } = require('./services/permissions');
const logger = require('./logger');
const staffService = require('./services/staff');
const activity = require('./services/activity');
const ticketLogs = require('./services/ticketLogs');
const audit = require('./services/audit');
const scheduler = require('./scheduler');
const health = require('./health');
const settings = require('./services/settings');
const { deployCommands } = require('./deploy-commands');
const { embed: buildEmbed, replyEphemeral, COLORS, log: logToChannel, embed, sendToChannel } = require('./utils');
const { TEAMS, LEVELS } = require('./constants');

if (!config.token) { console.error('❌ DISCORD_TOKEN غير موجود في .env'); process.exit(1); }
if (!config.guildId) { console.error('❌ GUILD_ID غير موجود في .env'); process.exit(1); }

// فشل سريع وواضح إن كان سجل الأوامر/المكوّنات غير سليم
try {
  validateRegistry();
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}

getDb();
// ===== عكس تحذيرات/أخطاء المسجّل إلى قناة السجلات =====
logger.setMirror((level, scope, message) => {
  const color = level === 'error' ? COLORS.danger : COLORS.warning;
  const emoji = level === 'error' ? '❌' : '⚠️';
  sendToChannel(client, 'staff-logs', { embeds: [buildEmbed(`${emoji} ${scope}`, message.slice(0, 1800), color)] }).catch(() => {});
});

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
  if (process.env.HEALTH_PORT) {
    try {
      healthServer = health.start({ scheduler });
      console.log(`🩺 Health endpoint يعمل على ${process.env.HEALTH_HOST || '127.0.0.1'}:${process.env.HEALTH_PORT}`);
    } catch (e) { logger.log('health').error('فشل تشغيل Health endpoint:', e); }
  }
});

let healthServer = null;

// ===== قراءة سجل التكتات من قناة البوت الخارجي =====
async function importExternalTicketLog(msg) {
  if (msg.author?.id === client.user?.id) return;
  const parsed = ticketLogs.parseExternalTicketMessage(msg);
  if (!parsed) return false;
  await ticketLogs.enrichDuration(msg, parsed); // يحسب زمن الاستجابة إن لم يذكر البوت المدة
  const result = ticketLogs.recordTicket(parsed);
  if (result.duplicate) return true;

  audit.record({
    action: 'ticket_auto_logged', actorId: parsed.loggedBy, targetId: parsed.claimer,
    details: { ticketId: parsed.ticketId, sourceMessageId: parsed.sourceMessageId, rowId: result.row.id, reopened: result.reopened },
    channelId: msg.channelId,
  });

  const durationText = parsed.duration == null ? 'غير مذكورة'
    : `${parsed.duration} دقيقة${parsed.durationSource === 'computed' ? ' (محسوبة من سجل القناة)' : ''}`;
  const e = embed(`🎫 تم تسجيل التكت تلقائياً ${result.reopened ? '♻️' : '✅'}`,
    `تمت قراءة سجل **${parsed.ticketId}** من البوت الخارجي بدون تدخل يدوي.\n\n👤 المستلم: <@${parsed.claimer}>\n🔒 الذي أغلقه: <@${parsed.closer}>\n⭐ التقييم: ${parsed.rating ?? '—'}\n⏱️ مدة الحل: ${durationText}\n🎯 النقاط: **${result.earned >= 0 ? '+' : ''}${result.earned}**\n🔗 [فتح سجل التكت](${parsed.ticketUrl || parsed.sourceUrl || msg.url})`,
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
    if (s?.isNew) await logToChannel(client, '🆕 إداري جديد', `<@${msg.author.id}> — ${s.rank} (${TEAMS[s.team]}) — تم تسجيله تلقائياً${s.status === 'probation' ? ' بحالة تجريبية' : ''}.`, COLORS.success);
    staffService.touchActivity(msg.author.id);
    activity.record(msg.author.id, msg.channel, msg.content);
  } catch (e) { console.error('خطأ في تتبع الرسالة:', e); }
});

// ===== تحديث الرتبة عند تغيير رتب الديسكورد =====
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  try {
    if (newM.guild.id !== config.guildId) return;
    const info = resolveStaff(newM);
    if (info) return void staffService.ensure(newM);
    // لم تبقَ أي رتبة إدارية: نحدّث الحالة بدل ترك العضو "نشطاً" للأبد
    const departure = staffService.syncDeparture(newM);
    if (departure) {
      audit.record({ action: 'staff_roles_removed', targetId: newM.id, details: departure });
      await logToChannel(client, '🚪 خروج من الفريق', `<@${newM.id}> — ${departure.rank} — نُزعت رتبه الإدارية يدوياً.\nالحالة: **${departure.previous} → ${departure.next}**`, COLORS.warning);
    }
  } catch (e) { logger.log('bot').error('خطأ في مزامنة الرتبة:', e); }
});

// ===== مغادرة السيرفر =====
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    if (member.guild.id !== config.guildId) return;
    const departure = staffService.markLeft(member.id);
    if (!departure) return;
    audit.record({ action: 'staff_left_guild', targetId: member.id, details: departure });
    await logToChannel(client, '👋 مغادرة السيرفر', `<@${member.id}> غادر السيرفر — ${departure.rank} (${TEAMS[departure.team] || departure.team}).\nتم تحديث حالته إلى **${departure.next}**.`, COLORS.danger);
  } catch (e) { logger.log('bot').error('خطأ في معالجة المغادرة:', e); }
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
      // ===== فرض الصلاحيات مركزياً على كل مكوّن =====
      // قبل هذا كان كل معالج مسؤولاً عن فحص نفسه، وثلاثة منها لم تفحص شيئاً.
      const entry = r.entry;
      if (entry.adminOnly && !isAdmin) {
        return replyEphemeral(i, '❌ هذا الإجراء متاح لمن يملك صلاحية **Administrator** فقط.', COLORS.danger);
      }
      if (!entry.adminOnly && !isSetup) {
        const effective = i.staffLevel || (serverManager ? LEVELS.GENERAL_MANAGER : 0);
        if (entry.serverManagerOnly && !serverManager) {
          return replyEphemeral(i, '❌ هذا الإجراء متاح لـ **Server Manager** أو **General Manager** فقط.', COLORS.danger);
        }
        if (effective < (entry.level || 0)) {
          return replyEphemeral(i, `❌ هذا الإجراء متاح لـ **${LEVEL_LABELS[entry.level] || 'صلاحية أعلى'}**.`, COLORS.danger);
        }
        if (entry.team && info?.team !== entry.team && !serverManager) {
          return replyEphemeral(i, `❌ هذا الإجراء يخص **${TEAMS[entry.team]}**.`, COLORS.danger);
        }
      }
      return await r.handler(i, r.args);
    }
  } catch (e) {
    logger.log('commands').error(`خطأ في التفاعل ${i.commandName || i.customId}:`, e);
    try { await replyEphemeral(i, '❌ حدث خطأ غير متوقع. تم تسجيله.', COLORS.danger); } catch {}
  }
});

// ===== معالجة الأخطاء على مستوى العميل والمسار =====
client.on(Events.Error, (e) => logger.log('discord').error('خطأ من ديسكورد:', e));
client.on(Events.Warn, (m) => logger.log('discord').warn(m));

process.on('unhandledRejection', (e) => logger.log('process').error('unhandledRejection:', e));
process.on('uncaughtException', (e) => {
  logger.log('process').error('uncaughtException:', e);
  // لا نُسقط البوت بسبب استثناء واحد؛ نسجّل ونستمر، وإن تكّرر يُرى في #staff-logs.
});

// ===== إغلاق لطيف: إيقاف المهام وإغلاق قاعدة البيانات =====
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 إغلاق (${signal})...`);
  try { scheduler.stop(); } catch (e) { console.error(e.message); }
  try { healthServer?.close(); } catch { /* ignore */ }
  try { client.destroy(); } catch { /* ignore */ }
  try { getDb().close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((e) => {
  console.error(`❌ فشل تسجيل الدخول: ${e.message}`);
  console.error('   تحقق من DISCORD_TOKEN في .env');
  process.exit(1);
});
