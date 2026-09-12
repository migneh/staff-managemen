'use strict';
const config = require('../config');
const { LEVELS, SUPPORT_RANKS, MOD_RANKS } = require('../constants');

/**
 * يحدد فريق ورتبة العضو من رتب الديسكورد (أعلى رتبة تفوز).
 * @returns {{team:string, rank:string, level:number, handlesTickets:boolean}|null}
 */
function resolveStaff(member) {
  if (!member?.roles?.cache) return null;
  let best = null;
  const check = (team, ranks) => {
    for (let i = ranks.length - 1; i >= 0; i--) {
      const r = ranks[i];
      const roleId = config.roles[team]?.[r.name];
      if (roleId && roleId !== 'ROLE_ID' && member.roles.cache.has(roleId)) {
        const cand = { team, rank: r.name, level: r.level, handlesTickets: !!r.handlesTickets, index: i };
        if (!best || cand.level > best.level) best = cand;
        break;
      }
    }
  };
  check('support', SUPPORT_RANKS);
  check('moderation', MOD_RANKS);
  return best;
}

function getLevel(member) {
  return resolveStaff(member)?.level ?? 0;
}

function hasLevel(member, level) {
  return getLevel(member) >= level;
}

function isBoss(member) { return getLevel(member) >= LEVELS.BOSS; }
function isManagement(member) { return getLevel(member) >= LEVELS.MANAGEMENT; }
function isSupervisor(member) { return getLevel(member) >= LEVELS.SUPERVISOR; }

function rankInfo(team, rankName) {
  const ranks = team === 'support' ? SUPPORT_RANKS : MOD_RANKS;
  return ranks.find(r => r.name === rankName) || null;
}

function levelName(level) {
  return Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'NONE';
}

const LEVEL_LABELS = {
  [LEVELS.STAFF]: 'كل الإداريين',
  [LEVELS.SENIOR]: 'الرتب المتقدمة فأعلى',
  [LEVELS.SUPERVISOR]: 'المشرفين فأعلى',
  [LEVELS.MANAGEMENT]: 'الإدارة العليا',
  [LEVELS.BOSS]: 'Boss فقط',
};

module.exports = { resolveStaff, getLevel, hasLevel, isBoss, isManagement, isSupervisor, rankInfo, levelName, LEVEL_LABELS };
