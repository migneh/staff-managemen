'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const scheduler = require('../scheduler');
const backup = require('../services/backup');
const settings = require('../services/settings');
const clock = require('../clock');
const { getDb } = require('../database');
const { embed, COLORS, divider } = require('../utils');
const kit = require('../ui/kit');

const JOB_LABELS = {
  absence: 'فحص الغياب',
  suspensions: 'رفع الإيقاف المنتهي',
  leaves: 'الإجازات',
  resignations: 'الاستقالات',
  backup: 'النسخ الاحتياطي',
  'daily-report': 'التقرير اليومي',
  'weekly-report': 'التقرير الأسبوعي',
  'monthly-report': 'التقرير الشهري',
};

/** صحة النظام: آخر تشغيل لكل مهمة + قاعدة البيانات + آخر نسخة احتياطية */
module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('system-status').setDescription('صحة البوت: المهام المجدولة، قاعدة البيانات، آخر نسخة احتياطية'),
      level: LEVELS.STAFF, serverManagerOnly: true,
      async execute(i) {
        const runs = scheduler.status();
        const jobs = scheduler.JOBS || [];
        const lines = jobs.map(j => {
          const last = runs[j.name];
          if (!last) return `⚪ **${JOB_LABELS[j.name] || j.name}** — لم يعمل بعد (${clock.TZ}: \`${j.expr}\`)`;
          const ok = last.ok ? '🟢' : '🔴';
          const when = kit.tsRelative(last.finishedAt);
          return `${ok} **${JOB_LABELS[j.name] || j.name}** — ${when}${last.error ? `\\n> ${String(last.error).slice(0, 120)}` : ''}`;
        });

        const db = getDb();
        const counts = {
          staff: db.prepare('SELECT COUNT(*) c FROM staff_members').get().c,
          activity: db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c,
          tickets: db.prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c,
          points: db.prepare('SELECT COUNT(*) c FROM promotion_points').get().c,
          audit: db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c,
        };
        const lastBackup = backup.listBackups()[0];
        const st = settings.status();

        const e = embed('🩺 صحة النظام', `${divider}`, COLORS.primary)
          .addFields(
            { name: '⏰ المهام المجدولة', value: lines.length ? lines.join('\\n') : 'لا توجد مهام مسجّلة (المجدول لم يبدأ بعد).' },
            { name: '🗄️ قاعدة البيانات', value: `إداريون: **${counts.staff}** • نشاط: **${counts.activity}** • تكتات: **${counts.tickets}**\\nنقاط: **${counts.points}** • عمليات مسجلة: **${counts.audit}**`, inline: false },
            { name: '💾 آخر نسخة احتياطية', value: lastBackup ? `${kit.tsRelative(lastBackup.modifiedAt)} · ${(lastBackup.size / 1024 / 1024).toFixed(2)} م.ب` : 'لا توجد — شغّل `/backup`', inline: true },
            { name: '⚙️ الإعداد', value: `رتب ${st.rolesDone}/${st.rolesTotal} • قنوات ${st.channelsDone}/${st.channelsTotal}`, inline: true },
          )
          .setFooter({ text: `المنطقة الزمنية: ${clock.TZ} • آخر تحديث` });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
};
