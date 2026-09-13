'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const tasks = require('../services/tasks');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, isValidDate } = require('../utils');

function taskPayload(userId, includeCompleted = false) {
  const rows = tasks.list(userId, { includeCompleted, limit: 20 });
  if (!rows.length) return { embeds: [embed('📋 مهامي', 'لا توجد مهام معلّقة حالياً. ✨', COLORS.success)], components: [] };
  const status = { pending: '⏳', completed: '✅', cancelled: '🚫' };
  const lines = rows.map(t => `${status[t.status] || '•'} **#${t.id} — ${t.title}**${t.due_date ? ` • الموعد: ${t.due_date}` : ''}${t.description ? `\n╰ ${t.description}` : ''}`);
  const buttons = rows.filter(t => t.status === 'pending').slice(0, 10).map(t => new ButtonBuilder().setCustomId(`task:complete:${t.id}`).setLabel(`إنهاء #${t.id}`).setEmoji('✅').setStyle(ButtonStyle.Success));
  const components = [];
  for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return { embeds: [embed('📋 مهامي', lines.join('\n\n'), COLORS.info).setFooter({ text: 'أكمل مهام التأهيل الثلاث للانتقال تلقائياً من التجربة إلى نشط.' })], components };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-tasks').setDescription('عرض مهامك ومهام التأهيل'),
      level: LEVELS.STAFF,
      async execute(i) { return i.reply({ ...taskPayload(i.user.id), ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('assign-task').setDescription('تعيين مهمة لإداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('عنوان المهمة').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('description').setDescription('تفاصيل المهمة').setRequired(false).setMaxLength(500))
        .addStringOption(o => o.setName('due').setDescription('آخر موعد YYYY-MM-DD — اختياري').setRequired(false).setMaxLength(10))
        .addStringOption(o => o.setName('type').setDescription('نوع المهمة').setRequired(false).addChoices(
          { name: 'عامة', value: 'general' }, { name: 'متابعة', value: 'follow_up' }, { name: 'تأهيل', value: 'onboarding' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        const due = i.options.getString('due');
        if (due && !isValidDate(due)) return replyEphemeral(i, '❌ الموعد يجب أن يكون بصيغة YYYY-MM-DD.', COLORS.danger);
        const task = tasks.create({ userId: user.id, title: i.options.getString('title'), description: i.options.getString('description'), dueDate: due, taskType: i.options.getString('type') || 'general', assignedBy: i.user.id });
        audit.record({ action: 'task_assigned', actorId: i.user.id, targetId: user.id, details: { taskId: task.id, title: task.title }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم تعيين المهمة **#${task.id}** لـ <@${user.id}>.`, COLORS.success);
      },
    },
  ],
  components: {
    'task:complete': async (i, [id]) => {
      const task = tasks.complete(Number(id), i.user.id);
      if (!task) return replyEphemeral(i, '❌ المهمة غير موجودة أو ليست لك أو أُنجزت مسبقاً.', COLORS.danger);
      audit.record({ action: 'task_completed', actorId: i.user.id, targetId: i.user.id, details: { taskId: task.id, title: task.title }, channelId: i.channelId });
      return i.update(taskPayload(i.user.id));
    },
  },
  taskPayload,
};
