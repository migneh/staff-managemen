'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const settings = require('../services/settings');
const activity = require('../services/activity');
const staffService = require('../services/staff');
const points = require('../services/points');
const promotions = require('../services/promotions');
const score = require('../services/score');
const clock = require('../clock');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-status').setDescription('عرض حالتك الحالية: النشاط، النقاط، والترقية')
        .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفصيلي أكثر')),
      level: LEVELS.STAFF,
async execute(i) {
         if (!settings.featureToggle('myStatusCommand')) return replyEphemeral(i, '❌ هذا الأمر معطّل حالياً.', COLORS.danger);
         const detailed = i.options.getBoolean('detailed') || false;
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        
        // Get activity stats for last 30 days
        const activityStats = activity.stats(userId, 30);
        const today = clock.today();
        const lastActivityHours = clock.hoursSince(member.last_activity || member.joined_at);
        
        // Calculate absence status
        let absenceStatus = 'نشط';
        let absenceColor = COLORS.success;
        if (lastActivityHours >= 96) {
          absenceStatus = 'تحذير absence (96+ ساعة)';
          absenceColor = COLORS.danger;
        } else if (lastActivityHours >= 72) {
          absenceStatus = 'تحذير initial (72+ ساعة)';
          absenceColor = COLORS.warning;
        }
        
        // Get current points and rank
        const currentPoints = points.total(userId);
        const currentRank = member.rank;
        const currentTeam = member.team;
        
        // Get promotion evaluation
        const promoEval = promotions.evaluate(member);
        const pointsToNextRank = promoEval.rule ? Math.max(0, promoEval.rule.points - currentPoints) : 0;
        const monthsInRank = clock.monthsSince(member.rank_since);
        
        // Get current score
        const currentScoreObj = score.compute(member);
        const currentScore = currentScoreObj.score;
        
        // Build embed
        const e = kit.card({
          title: `📊 حالتك الحالية — <@${userId}>`,
          description: `${member.rank} • ${TEAMS[member.team]} • ${STATUS[member.status]}`,
          fields: [
            { name: '💯 نقاطك الحالية', value: `${arDigits(currentPoints)}` },
            { name: '📈 تقييمك (Score)', value: `${currentScore}/100` },
            { name: '📅 النشاط (30 يوم)', value: `${arDigits(activityStats.activeDays)} يوم` },
            { name: '💬 الرسائل (30 يوم)', value: `${arDigits(activityStats.messages)}` },
            { name: '🎯 النقاط المرجحة (30 يوم)', value: `${arDigits(activityStats.weighted)}` },
            { name: '⏰ آخر نشاط', value: `${tsRelative(member.last_activity || member.joined_at)}` },
            { name: '🚦 حالة الغياب', value: absenceStatus },
            { name: '📆 الوقت في الرتبة', value: `${monthsInRank.toFixed(1)} شهر` },
          ],
          color: absenceColor,
          footer: kit.footerLine(`الحالة العامة: ${absenceStatus === 'نشط' ? 'جيد' : 'يحتاج اهتمام'}`),
        });
        
        // Add promotion info if applicable
        if (promoEval.rule) {
          const passedChecks = promoEval.checks.filter(c => c.pass).length;
          const totalChecks = promoEval.checks.length;
          const progressPercent = Math.round((passedChecks / totalChecks) * 100);
          
          e.addFields({
            name: `🎯 الترقية القادمة: ${promoEval.rule.to}`,
            value: `${progressBar(passedChecks, totalChecks, 10)} **${passedChecks}/${totalChecks}** شرط مكتمل\n${promoEval.eligible ? '✅ مؤهل للتقدم' : '❌ غير مؤهل actuellement'}\n${pointsToNextRank > 0 ? `💔 تحتاج ${arDigits(pointsToNextRank)} نقطة إضافية` : '✅ نقاط كافية للترقية'}`,
          });
          
          if (detailed) {
            // Add detailed requirement breakdown
            const reqDetails = promoEval.checks.map(check => {
              const statusIcon = check.pass ? '✅' : '❌';
              return `${statusIcon} **${check.label}**: ${check.actual} / ${check.required}`;
            }).join('\n');
            
            e.addFields({
              name: '📋 تفاصيل المتطلبات',
              value: reqDetails.slice(0, 1024),
            });
          }
        } else {
          e.addFields({
            name: '🏆 الترقية',
            value: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)',
          });
        }
        
        // Add absence warning info if applicable
        if (lastActivityHours >= 72) {
          const hoursUntilWarning = 96 - lastActivityHours;
          const hoursUntilAlert = 96 - lastActivityHours;
          
          e.addFields({
            name: '⚠️ تحذيرات الغياب',
            value: lastActivityHours >= 96 
              ? `⛔ لديك تحذير absence منذ ${Math.floor(lastActivityHours - 96)} ساعات\n⚠️ سيتم تنبيه الفريق إذا لم تكن نشطاً خلال ${Math.max(0, 96 - lastActivityHours)} ساعات القادمة`
              : `⚠️ ستحصل على تحذير absence خلال ${Math.floor(hoursUntilWarning)} ساعات إذا لم تكن نشطاً\n🚨 سيحصل الفريق على تنبيه خلال ${Math.max(0, hoursUntilAlert)} ساعات إذا لم تكن نشطاً`,
          });
        }
        
        // Add detailed section if requested
        if (detailed) {
          // Get recent points history
          const recentPoints = points.history(userId, 10);
          if (recentPoints.length > 0) {
            const pointsHistory = recentPoints.map(p => {
              const icon = p.points > 0 ? '🟢' : '🔴';
              return `${icon} ${arDigits(Math.abs(p.points))} — ${p.reason || p.reason_key}`;
            }).join('\n');
            
            e.addFields({
              name: '📜 آخر 10 حركات نقاط',
              value: pointsHistory.slice(0, 1024),
            });
          }
          
          // Get recent activity by channel type
          e.addFields({
            name: '📊 تفصيل النشاط (30 يوم)',
            value: Object.entries(activityStats.byType).map(([type, count]) => {
              const typeNames = { 
                ticket: '🎫 تكتات', 
                staff: '💬 إدارة', 
                moderation: '🛡️ إشراف', 
                general: '🌐 عام' 
              };
              const typeName = typeNames[type] || type;
              return `${typeName}: ${arDigits(count)}`;
            }).join(' • '),
          });
        }
        
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
  
  components: {},
};