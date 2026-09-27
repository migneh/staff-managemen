'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const staffService = require('../services/staff');
const promotions = require('../services/promotions');
const points = require('../services/points');
const score = require('../services/score');
const clock = require('../clock');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative, tsDate } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('promotion-progress').setDescription('عرض تفصيلي لتقدمك نحو الترقية القادمة')
        .addBooleanOption(o => o.setName('show-remaining').setDescription('عرض المتطلبات المتبقية فقط')),
      level: LEVELS.STAFF,
      async execute(i) {
        const showRemainingOnly = i.options.getBoolean('show-remaining') || false;
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        
        const promoEval = promotions.evaluate(member);
        if (!promoEval.rule) {
          return i.reply({ embeds: [kit.card({
            title: '📈 حالة الترقية',
            description: `رتبتك الحالية: **${member.rank}**\n${promoEval.reason}`,
            color: COLORS.info,
            footer: kit.footerLine(`لا توجد ترقية تلقائية لهذه الرتبة`),
          })], ephemeral: true });
        }
        
        const rule = promoEval.rule;
        const passedChecks = promoEval.checks.filter(c => c.pass).length;
        const totalChecks = promoEval.checks.length;
        const progressPercent = Math.round((passedChecks / totalChecks) * 100);
        const pointsToNextRank = Math.max(0, rule.points - points.total(userId));
        const monthsInRank = clock.monthsSince(member.rank_since);
        const monthsToNextRank = Math.max(0, rule.months - monthsInRank);
        
        // Build requirement details
        const requirementDetails = promoEval.checks.map(check => {
          const statusIcon = check.pass ? '✅' : '❌';
          const progressBar = progressBar(
            typeof check.actual === 'number' && typeof check.required === 'number' 
              ? Math.min(check.actual, check.required) 
              : check.pass ? 1 : 0,
            typeof check.required === 'number' ? check.required : 100,
            10
          );
          
          let actualValue = check.actual;
          if (typeof actualValue === 'number') {
            actualValue = arDigits(actualValue);
          }
          
          return `${statusIcon} **${check.label}**: ${actualValue} / ${check.required} ${progressBar}`;
        }).join('\n');
        
        // Build embed
        const e = kit.card({
          title: `📈 تقدم الترقية: ${member.rank} → ${rule.to}`,
          description: `المتطلبات المكتملة: **${passedChecks}/${totalChecks}** (${progressPercent}%)`,
          fields: [
            { name: '⏱️ الوقت في الرتبة', value: `${arDigits(monthsInRank.toFixed(1))} شهر / ${rule.months} شهر` },
            { name: '💯 النقاط الحالية', value: `${arDigits(points.total(userId))} / ${arDigits(rule.points)} نقطة` },
            { name: '📈 التقييم (Score)', value: `${score.compute(member).score}/100` },
            { name: '📋 متطلبات الترقية', value: requirementDetails.slice(0, 1024) },
          ],
          color: promoEval.eligible ? COLORS.success : COLORS.warning,
          footer: kit.footerLine(
            promoEval.eligible 
              ? `✅ مؤهل للتقدم للترقية! استخدم \`/request-promotion\` للتقديم` 
              : `⏳ retire remaining: ${monthsToNextRank > 0 ? `${arDigits(monthsToNextRank)} شهر` : '	time'} | ${pointsToNextRank > 0 ? `${arDigits(pointsToNextRank)} نقطة` : '	time'}${
                  promoEval.checks.some(c => !c.pass && c.label.includes('التقييم')) ? ' | التقييم غير كافٍ' : ''
                }`
          ),
        });
        
        // Add remaining requirements section if requested
        if (showRemainingOnly) {
          const remainingChecks = promoEval.checks.filter(c => !c.pass);
          if (remainingChecks.length > 0) {
            const remainingDetails = remainingChecks.map(check => {
              const needed = typeof check.required === 'number' 
                ? `${arDigits(Math.max(0, check.required - (typeof check.actual === 'number' ? check.actual : 0)))}` 
                : check.required;
              
              return `❌ **${check.label}**: لا زلت بحاجة إلى ${needed}`;
            }).join('\n');
            
            e.addFields({
              name: '🔴 المتطلبات المتبقية',
              value: remainingDetails.slice(0, 1024),
            });
          }
        }
        
        // Add time-based estimates
        const timeEstimates = [];
        if (monthsToNextRank > 0) {
          timeEstimates.push(`⏰ الوقت المطلوب في الرتبة: ${arDigits(monthsToNextRank)} شهر`);
        }
        if (pointsToNextRank > 0) {
          // Estimate based on recent points earning rate
          const recentPoints = points.history(userId, 30, { allEpochs: true }); // Last 30 days, all epochs
          const monthlyPoints = recentPoints.reduce((sum, p) => sum + p.points, 0);
          const pointsPerDay = monthlyPoints / 30;
          if (pointsPerDay > 0) {
            const daysNeeded = Math.ceil(pointsToNextRank / pointsPerDay);
            timeEstimates.push(`📈 الوقت المتوقع للنقاط: ${arDigits(Math.ceil(daysNeeded / 30))} شهر${daysNeeded % 30 !== 0 ? ` (≈${arDigits(daysNeeded % 30)} يوم)` : ''}`);
          }
        }
        
        if (timeEstimates.length > 0) {
          e.addFields({
            name: '📅 التقديرات الزمنية',
            value: timeEstimates.join('\n'),
          });
        }
        
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
  
  components: {},
};