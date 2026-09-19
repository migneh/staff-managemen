'use strict';
const { LEVELS } = require('../constants');

const modules = [
  require('./setup'),
  require('./help'),
  require('./faq'),
  require('./logging'),
  require('./appeals'),
  require('./leaves'),
  require('./resignations'),
  require('./records'),
  require('./recognition'),
  require('./promotions'),
  require('./reports'),
  require('./tasks'),
  require('./audit'),
  require('./backup'),
  require('./governance'),
  require('./system'),
];

/**
 * صلاحيات كل مكوّن (زر/قائمة/نموذج) تُعرَّف هنا مرة واحدة وتُفرض مركزياً في
 * src/index.js. قبل هذا كان كل معالج مسؤولاً عن فحص المستوى بنفسه، وثلاثة منها
 * نسيت الفحص (promo:reject و faq:hist و leave:details) فأصبحت مفتوحة لأي إداري.
 *
 * level          : أدنى مستوى صلاحية مطلوب (الافتراضي: كل الإداريين)
 * team           : الفريق المسموح (اختياري)
 * owner          : 'self' يعني أن المعالج يتحقق من صاحب الطلب بنفسه،
 *                  'other' يعني أنه يخص إداريين آخرين (للتوثيق)
 * serverManagerOnly: لمالك السيرفر / Server Manager فقط
 * adminOnly      : Administrator فقط
 * guarded        : true يعني أن المعالج يفحص الصلاحية داخلياً ويجب تركه (توثيق)
 */
const COMPONENT_ACCESS = {
  // ===== الإعداد: Administrator فقط (مفروض في index.js) =====
  'setup:home': { adminOnly: true },
  'setup:roles': { adminOnly: true },
  'setup:channels': { adminOnly: true },
  'setup:activity': { adminOnly: true },
  'setup:ticket-source': { adminOnly: true },
  'setup:governance': { adminOnly: true },
  'setup:policies': { adminOnly: true },
  'setup:vacation-timing': { adminOnly: true },
  'setup:pickrole': { adminOnly: true },
  'setup:pickchannel': { adminOnly: true },
  'setup:pickactivity': { adminOnly: true },
  'setup:pickticketsource': { adminOnly: true },
  'setup:pickgovernance': { adminOnly: true },
  'setup:autoroles': { adminOnly: true },
  'setup:autochannels': { adminOnly: true },
  'setup:autocreate': { adminOnly: true },
  'setup:policies-edit-leave': { adminOnly: true },
  'setup:policies-leave-modal': { adminOnly: true },
  'setup:policies-edit-resign': { adminOnly: true },
  'setup:policies-resign-modal': { adminOnly: true },
  'setup:policies-reset': { adminOnly: true },

  // ===== قاعدة المعرفة: القراءة للجميع، الإدارة العليا فقط =====
  'faq:cat': { level: LEVELS.STAFF },
  'faq:all': { level: LEVELS.STAFF },
  'faq:view': { level: LEVELS.STAFF },
  'faq:ack': { level: LEVELS.STAFF, owner: 'self' },
  'faq:search': { level: LEVELS.STAFF },
  'faq:searchmodal': { level: LEVELS.STAFF },
  'faq:unread': { level: LEVELS.STAFF, owner: 'self' },
  'faq:hist': { level: LEVELS.MANAGEMENT }, // كان بلا فحص مفتوحاً للجميع
  'faq:addmodal': { level: LEVELS.MANAGEMENT },
  'faq:editmodal': { level: LEVELS.MANAGEMENT },
  'faq:delconfirm': { level: LEVELS.MANAGEMENT },
  'faq:tmpllist': { level: LEVELS.MANAGEMENT },
  'faq:panels': { level: LEVELS.MANAGEMENT },
  'faq:template-addmodal': { level: LEVELS.MANAGEMENT },
  'faq:template-editmodal': { level: LEVELS.MANAGEMENT },
  'faq:templatedelconfirm': { level: LEVELS.MANAGEMENT },
  'faq:cfgpin': { level: LEVELS.MANAGEMENT },
  'faq:cfgpinmodal': { level: LEVELS.MANAGEMENT },
  'faq:cfghide': { level: LEVELS.MANAGEMENT },
  'faq:cfghidemodal': { level: LEVELS.MANAGEMENT },
  'faq:cfgnote': { level: LEVELS.MANAGEMENT },
  'faq:cfgenotemodal': { level: LEVELS.MANAGEMENT },
  'faq:cfgclear': { level: LEVELS.MANAGEMENT },
  'faq:cfgrefresh': { level: LEVELS.MANAGEMENT },
  'faq:cancel': { level: LEVELS.STAFF },

  // ===== تسجيل العمل =====
  'ticket:log': { level: LEVELS.STAFF, team: 'support' },
  'modaction:log': { level: LEVELS.STAFF, team: 'moderation' },

  // ===== الإجازات =====
  'leave:modal': { level: LEVELS.STAFF, owner: 'self' },
  'leave:myleaves': { level: LEVELS.STAFF, owner: 'self' },
  'leave:pickaction': { level: LEVELS.STAFF, owner: 'self' },
  'leave:confirmcancel': { level: LEVELS.STAFF, owner: 'self' },
  'leave:extendmodal': { level: LEVELS.STAFF, owner: 'self' },
  'leave:cancelpick': { level: LEVELS.STAFF },
  'leave:pending': { level: LEVELS.MANAGEMENT },   // كان بلا فحص
  'leave:details': { level: LEVELS.MANAGEMENT },   // كان بلا فحص — يكشف تفاصيل طلبات الآخرين
  'leave:approve': { level: LEVELS.MANAGEMENT, guarded: true },
  'leave:reject': { level: LEVELS.MANAGEMENT, guarded: true },
  'leave:rejectmodal': { level: LEVELS.MANAGEMENT, guarded: true },
  'leave:cancelquick': { level: LEVELS.MANAGEMENT, guarded: true },

  // ===== الاستقالات (سرية — الإدارة العليا) =====
  'resign:modal': { level: LEVELS.STAFF, owner: 'self' },
  'resign:pickreason': { level: LEVELS.STAFF, owner: 'self' },
  'resign:withdrawlist': { level: LEVELS.STAFF, owner: 'self' },
  'resign:pickwithdraw': { level: LEVELS.STAFF, owner: 'self' },
  'resign:confirmwithdraw': { level: LEVELS.STAFF, owner: 'self' },
  'resign:cancelwithdraw': { level: LEVELS.STAFF },
  'resign:accept': { level: LEVELS.BOSS, guarded: true },
  'resign:acceptmodal': { level: LEVELS.BOSS, guarded: true },
  'resign:reject': { level: LEVELS.MANAGEMENT, guarded: true },
  'resign:rejectmodal': { level: LEVELS.MANAGEMENT, guarded: true },
  'resign:hold': { level: LEVELS.MANAGEMENT, guarded: true },
  'resign:holdmodal': { level: LEVELS.MANAGEMENT, guarded: true },
  'resign:interview': { level: LEVELS.MANAGEMENT, guarded: true },
  'resign:interviewmodal': { level: LEVELS.MANAGEMENT, guarded: true },

  // ===== الترقيات =====
  'promo:modal': { level: LEVELS.STAFF, owner: 'self' },
  'promo:approve': { level: LEVELS.MANAGEMENT, guarded: true },
  'promo:reject': { level: LEVELS.MANAGEMENT },        // كان بلا فحص نهائياً
  'promo:rejectmodal': { level: LEVELS.MANAGEMENT },   // وكان يمنح تبريد 30 يوماً لأي عضو

  // ===== الاستئنافات والتقدير والمهام والسجل =====
  'appeal:approve': { level: LEVELS.MANAGEMENT, guarded: true },
  'appeal:reject': { level: LEVELS.MANAGEMENT, guarded: true },
  'recognition:approve': { level: LEVELS.MANAGEMENT, guarded: true },
  'recognition:reject': { level: LEVELS.MANAGEMENT, guarded: true },
  'score:weightsmodal': { level: LEVELS.MANAGEMENT, guarded: true },
  'task:complete': { level: LEVELS.STAFF, owner: 'self' },

  // ===== الردود الشخصية من /me و /help =====
  'me:perf': { level: LEVELS.STAFF, owner: 'self' },
  'me:record': { level: LEVELS.STAFF, owner: 'self' },
  'me:promo': { level: LEVELS.STAFF, owner: 'self' },
  'points:contest': { level: LEVELS.STAFF, owner: 'self' },
  'points:contestmodal': { level: LEVELS.STAFF, owner: 'self' },
  'help:open': { level: LEVELS.STAFF },
  'help:section': { level: LEVELS.STAFF },
};

const commands = new Map();
const components = new Map();

const DEFAULTS = { level: LEVELS.STAFF, team: null, owner: null };

function registerComponent(id, def) {
  if (components.has(id)) throw new Error(`معرّف مكوّن مكرر: ${id}`);
  const meta = COMPONENT_ACCESS[id] || {};
  const entry = typeof def === 'function'
    ? { ...DEFAULTS, handle: def, ...meta }
    : { ...DEFAULTS, ...def, ...meta };
  components.set(id, entry);
}

for (const m of modules) {
  for (const c of m.commands || []) {
    if (!c.data?.name) throw new Error('أمر بدون data.name');
    if (commands.has(c.data.name)) throw new Error(`اسم أمر مكرر: ${c.data.name}`);
    commands.set(c.data.name, c);
  }
  for (const [id, def] of Object.entries(m.components || {})) registerComponent(id, def);
}

/**
 * تحقق من سلامة السجل عند الإقلاع — يمنع أخطاء صامتة.
 * يفشل بسرعة إن وُجد تعارض بادئات (مثل "leave" و"leave:x") لأن الراوتر
 * يطابق أطول بادئة، أو إن كان مكوّناً بلا تعريف صلاحيات.
 */
function validateRegistry({ throwOnError = true } = {}) {
  const problems = [];
  const ids = [...components.keys()];
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && b.startsWith(`${a}:`)) problems.push(`تعارض بادئات: "${a}" و "${b}"`);
    }
  }
  const declared = new Set(Object.keys(COMPONENT_ACCESS));
  for (const id of ids) {
    if (!declared.has(id)) {
      // غير مُعرَّف صراحةً: يُطبَّق عليه الافتراضي (كل الإداريين) — نُبلّغ به ليكون قراراً واعياً
      problems.push(`مكوّن بلا تعريف صلاحيات صريح: "${id}"`);
    }
  }
  for (const id of declared) {
    if (!components.has(id)) problems.push(`صلاحيات معرّفة لمكوّن غير موجود: "${id}"`);
  }
  if (problems.length && throwOnError) throw new Error(`خلل في سجل المكوّنات:\n- ${problems.join('\n- ')}`);
  return problems;
}

/** يفكك customId مثل "faq:ack:12" إلى المفتاح "faq:ack" والمعاملات ["12"] */
function resolveComponent(customId) {
  const parts = String(customId || '').split(':');
  for (let n = parts.length; n >= 1; n--) {
    const key = parts.slice(0, n).join(':');
    if (components.has(key)) return { entry: components.get(key), handler: components.get(key).handle, args: parts.slice(n) };
  }
  return null;
}

module.exports = { commands, components, resolveComponent, validateRegistry, modules, COMPONENT_ACCESS };
