'use strict';
const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const { LEVEL_LABELS } = require('../services/permissions');
const staffService = require('../services/staff');
const reports = require('../services/reports');
const promo = require('../services/promotions');
const faq = require('../services/faq');
const points = require('../services/points');
const taskService = require('../services/tasks');
const { getDb } = require('../database');
const { embed, userEmbed, COLORS, progressBar, scoreColor, scoreEmoji, hoursSince, divider, replyEphemeral } = require('../utils');

const SECTIONS = [
  { id: 'start', emoji: '🚀', label: 'ابدأ من هنا', desc: 'أهم 5 أوامر تحتاجها يومياً' },
  { id: 'faq', emoji: '📚', label: 'قاعدة المعرفة', desc: 'القوانين والتعليمات' },
  { id: 'work', emoji: '🎫', label: 'تسجيل العمل', desc: 'التكتات والإجراءات الإشرافية' },
  { id: 'requests', emoji: '📨', label: 'الطلبات', desc: 'إجازة • استقالة • ترقية' },
  { id: 'perf', emoji: '📊', label: 'الأداء والسجل', desc: 'Score • النقاط • الإنذارات' },
  { id: 'manage', emoji: '🛠️', label: 'أدوات الإدارة', desc: 'للمشرفين والإدارة العليا', minLevel: LEVELS.SUPERVISOR },
];

const cmd = (name, desc, lvl) => `> **/${name}** — ${desc}${lvl ? ` \`${lvl}\`` : ''}`;

function section(id, level, team) {
  switch (id) {
    case 'start': return embed('🚀 ابدأ من هنا', [
      'مرحباً بك! هذه أهم الأوامر:', '',
      cmd('me', 'لوحتك الشخصية: الحالة، Score، الترقية، المهام المعلّقة'),
      team === 'support' ? '🎫 سجل التكتات يُستورد تلقائياً من قناة بوت التكتات — استخدم /log-ticket فقط عند تعطل السجل الخارجي.' : team === 'moderation' ? cmd('log-action', 'سجّل كل إجراء إشرافي — **الإجراء بدون تسجيل = مخالفة**') : cmd('manage-general', 'إدارة التعيينات العامة (لـ General Manager فقط)'),
      cmd('faq', 'اقرأ القوانين — المدخلات 📌 تتطلب تأكيد قراءة'),
      cmd('request-leave', 'قبل أي غياب يتجاوز 72 ساعة'),
      cmd('promotion-status', 'شروط ترقيتك القادمة بـ ✅/❌'), '',
      '💡 **نصيحة:** كل ردود البوت خاصة بك (لا يراها غيرك) إلا ما يُرسل في قنوات السجلات.',
    ].join('\n'), COLORS.primary);
    case 'faq': return embed('📚 قاعدة المعرفة', [
      cmd('faq', 'تصفح التصنيفات (11 تصنيف)'), cmd('faq-list', 'كل المدخلات في قائمة واحدة'), '',
      '**الإدارة العليا:**', cmd('faq-add', 'إضافة مدخل (نموذج)'), cmd('faq-edit', 'تعديل مدخل — يُطلب من الجميع إعادة قراءته'), cmd('faq-delete', 'حذف مع بقاء النسخة في التاريخ'), cmd('faq-panel', 'لوحة ثابتة في القناة تتحدث تلقائياً'), cmd('faq-refresh', 'تحديث اللوحات يدوياً'),
    ].join('\n'), COLORS.info);
    case 'work': return embed('🎫 تسجيل العمل', [
      '**فريق الدعم الفني:**',
      '• سجل التكتات يُقرأ تلقائياً من قناة البوت الخارجي بعد ضبطها من `/setup` — لا حاجة لـ `/log-ticket`.',
      '• عند تعطل البوت الخارجي فقط استخدم `/log-ticket` كخطة احتياطية.',
      '• تكت مغلق **+2** • تقييم 5 **+5** • تقييم 4 **+2** • تقييم 1-2 **-3** • معاد فتحه **-5**', '',
      '**فريق الإشراف:**', cmd('log-action', 'اختر النوع ثم املأ: العضو، السبب، المدة، الدليل'),
      '• كل إجراء **+3** • استجابة سريعة **+5** (يمنحها المشرف)', '',
      '⚠️ **القاعدة الذهبية:** أي عقوبة بدون تسجيل = مخالفة على المشرف نفسه.',
    ].join('\n'), COLORS.warning);
    case 'requests': return embed('📨 الطلبات', [
      '**🏖️ الإجازات**', cmd('request-leave', 'اختر النوع ← نموذج بالتواريخ'), cmd('my-leaves', 'حالة طلباتك'),
      '• الحد 30 يوم • 3 مجازين كحد أقصى • تذكير قبل البداية والنهاية بـ 24س • Score يتجمد', '',
      '**📤 الاستقالة**', cmd('resign', 'سرية تماماً — تصل للإدارة فقط'), '• فترة إشعار 3 أيام • القبول من Boss فقط', '',
      '**📈 الترقية**', cmd('promotion-info', 'كل الشروط والنقاط'), cmd('promotion-status', 'أين أنت من الشروط'), cmd('request-promotion', 'يُفتح فقط عند اكتمال الشروط'),
    ].join('\n'), COLORS.success);
    case 'perf': return embed('📊 الأداء والسجل', [
      cmd('me', 'لوحة شاملة'), cmd('my-performance', 'تقرير مفصّل: Score وعوامله، التكتات/الإجراءات، الغياب، الإجازات'), cmd('my-record', 'إنذاراتك وملاحظاتك ونقاطك'), '',
      '**كيف يُحسب Score؟**',
      '• **Helper:** الشات 25 + التواجد 25 + التفاعل 25 + تقييم المشرف 25',
      '• **Support فأعلى:** التكتات 30 + السرعة والتقييم 25 + الشات 25 + التواجد 20',
      '• **الإشراف:** المخالفات 30 + سرعة الاستجابة 25 + النشاط 25 + الالتزام 20', '',
      '🟢 85+ ممتاز • 🔵 70+ جيد • 🟡 50+ يحتاج تحسين • 🔴 أقل ضعيف',
    ].join('\n'), COLORS.info);
    case 'manage': return embed('🛠️ أدوات الإدارة', [
      '**المشرفون فأعلى:**', cmd('staff-report', 'تقرير أي إداري'), cmd('team-report', 'نظرة على الفريق كاملاً'), cmd('leaderboard', 'الترتيب (سري)'),
      cmd('add-note', 'ملاحظة 🟢 +5 / 🟡 -10 (يمكن جعلها سرية)'), cmd('warn', 'إنذار شفهي (المشرف) / رسمي (الإدارة) / أخير (Boss)'), cmd('staff-record', 'سجل أي إداري'),
      cmd('rate-staff', 'التقييم اليدوي الذي يدخل في Score'), cmd('award-points', 'نقاط يدوية: مساعدة عضو جديد، حالة معقدة…'), cmd('assign-task', 'تعيين مهام ومتابعات'), cmd('audit-log', 'سجل العمليات الحساسة'), '',
      '**الإدارة العليا:**', cmd('review-leaves', 'الإجازات المعلّقة'), cmd('review-promotion', 'الترقيات المعلّقة'), '• الاستقالات تُراجع من قناتها بالأزرار', '',
      '**Server Manager / General Manager:**', cmd('manage-general', 'تعيين أو إزالة الإدارة العامة'), cmd('backup', 'نسخة احتياطية لقاعدة البيانات'), '',
      '**Administrator:**', cmd('setup', 'الرتب والقنوات بقوائم اختيار'),
    ].join('\n'), COLORS.danger);
  }
}

function helpPayload(id, level, team) {
  const menu = new StringSelectMenuBuilder().setCustomId('help:section').setPlaceholder('📖 اختر قسماً...')
    .addOptions(SECTIONS.filter(s => !s.minLevel || level >= s.minLevel).map(s => ({ label: s.label, value: s.id, description: s.desc, emoji: s.emoji, default: s.id === id })));
  return { embeds: [section(id, level, team).setFooter({ text: `صلاحيتك: ${LEVEL_LABELS[level]} • ${TEAMS[team]}` })], components: [new ActionRowBuilder().addComponents(menu)] };
}

function dashboard(i) {
  const s = staffService.get(i.user.id);
  const r = reports.individual(s);
  const ev = promo.evaluate(s);
  const unread = faq.unreadFor(i.user.id).length;
  const db = getDb();
  const pendingLeave = db.prepare(`SELECT id FROM leave_requests WHERE user_id = ? AND status = 'pending'`).get(i.user.id);
  const pendingPromo = promo.pendingRequest(i.user.id);
  const pendingTasks = taskService.pendingCount(i.user.id);
  const cd = points.activeCooldown(i.user.id);
  const h = hoursSince(s.last_activity);

  const statusIcon = { active: '🟢', inactive: '🟠', on_leave: '🏖️', probation: '🧪', suspended: '⛔', resigned: '⚫' }[s.status];
  const tasks = [];
  if (unread) tasks.push(`📌 **${unread}** مدخل مهم لم تقرأه — \`/faq\` ← «غير المقروءة»`);
  if (h > 48 && s.status !== 'on_leave') tasks.push(`⏰ آخر نشاط منذ **${Math.floor(h)}** ساعة — التنبيه عند 72`);
  if (pendingLeave) tasks.push(`🏖️ طلب إجازة #${pendingLeave.id} بانتظار المراجعة`);
  if (pendingPromo) tasks.push(`📈 طلب ترقية #${pendingPromo.id} بانتظار المراجعة`);
  if (ev.eligible && !pendingPromo) tasks.push(`🎉 **أنت مؤهل للترقية!** — \`/request-promotion\``);
  if (pendingTasks) tasks.push(`📋 لديك **${pendingTasks}** مهمة معلّقة — \`/my-tasks\``);
  if (cd) tasks.push(`🧊 تجميد الترقية حتى ${cd.until}`);

  const e = userEmbed(i.member, `${statusIcon} لوحتك — ${s.rank}`, `${TEAMS[s.team]} • ${STATUS[s.status]} • بالرتبة منذ <t:${Math.floor(new Date(s.rank_since.replace(' ', 'T') + 'Z') / 1000)}:R>`, scoreColor(r.score));
  e.addFields(
    { name: `${scoreEmoji(r.score)} Score ${r.score}/100 — ${r.grade}`, value: `${progressBar(r.score, 100, 20)}\n` + r.factors.map(f => `${f.name} **${f.pts}**/${f.max}`).join(' • ') },
    { name: '🎯 نقاط الترقية', value: `**${r.points}**${ev.rule ? ` / ${ev.rule.points}` : ''}`, inline: true },
    { name: s.team === 'support' ? '🎫 تكتات الشهر' : '🛡️ إجراءات الشهر', value: `**${s.team === 'support' ? r.raw.tickets : r.raw.actions}**`, inline: true },
    { name: '📅 أيام النشاط', value: `**${r.raw.activeDays}**/30`, inline: true },
  );
  if (ev.rule) {
    const passed = ev.checks.filter(c => c.pass).length;
    e.addFields({ name: `📈 الترقية القادمة: ${ev.rule.to}`, value: `${progressBar(passed, ev.checks.length, 12)} **${passed}/${ev.checks.length}** شرط\n${ev.checks.filter(c => !c.pass).slice(0, 3).map(c => `❌ ${c.label}: ${c.actual} → ${c.required}`).join('\n') || '✅ كل الشروط مكتملة'}` });
  }
  e.addFields({ name: `📋 مهامك (${tasks.length})`, value: tasks.length ? tasks.join('\n') : '✨ لا شيء معلّق — استمر!' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me:perf').setLabel('التقرير الكامل').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('me:record').setLabel('سجلي').setEmoji('📁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('me:promo').setLabel('الترقية').setEmoji('📈').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('faq:unread').setLabel(unread ? `غير المقروءة (${unread})` : 'غير المقروءة').setEmoji('📌').setStyle(unread ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help:open').setLabel('مساعدة').setEmoji('❓').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row] };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('help').setDescription('❓ دليل استخدام البوت'),
      level: LEVELS.STAFF,
      async execute(i) { return i.reply({ ...helpPayload('start', i.staffLevel, i.staffInfo?.team || 'general_management'), ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('me').setDescription('🏠 لوحتك الشخصية: الحالة، Score، الترقية، المهام'),
      level: LEVELS.STAFF,
      async execute(i) {
        if (!i.staffInfo) return replyEphemeral(i, 'ℹ️ لا توجد لك بطاقة إداري لأنك تستخدم صلاحية Server Manager فقط.', COLORS.info);
        return i.reply({ ...dashboard(i), ephemeral: true });
      },
    },
  ],
  components: {
    'help:section': async (i) => i.update(helpPayload(i.values[0], i.staffLevel, i.staffInfo.team)),
    'help:open': async (i) => i.reply({ ...helpPayload('start', i.staffLevel, i.staffInfo?.team || 'general_management'), ephemeral: true }),
    'me:perf': async (i) => { const { commands } = require('./index'); return commands.get('my-performance').execute(i); },
    'me:record': async (i) => { const { commands } = require('./index'); return commands.get('my-record').execute(i); },
    'me:promo': async (i) => { const { commands } = require('./index'); return commands.get('promotion-status').execute(i); },
  },
};
