'use strict';

// ===== مستويات الصلاحيات =====
const LEVELS = {
  STAFF: 1,
  SENIOR: 2,
  SUPERVISOR: 3,
  MANAGEMENT: 4,
  BOSS: 5,
  // الإدارة العامة أعلى من مستويات الفريقين، لكنها لا تدخل في سلم الترقيات.
  GENERAL_MANAGEMENT: 6,
  GENERAL_MANAGER: 7,
};

// ===== الرتب (الترتيب من الأدنى للأعلى) =====
const SUPPORT_RANKS = [
  { name: 'Helper', category: 'تنفيذي', level: LEVELS.STAFF, handlesTickets: false },
  { name: 'Support', category: 'تنفيذي', level: LEVELS.STAFF, handlesTickets: true },
  { name: 'Support Expert', category: 'تنفيذي', level: LEVELS.SENIOR, handlesTickets: true },
  { name: 'Support Analyst', category: 'تنفيذي', level: LEVELS.SENIOR, handlesTickets: true },
  { name: 'Supervisor Manager', category: 'إشرافي', level: LEVELS.SUPERVISOR, handlesTickets: true },
  { name: 'Support Office', category: 'إدارة عليا', level: LEVELS.MANAGEMENT, handlesTickets: true },
  { name: 'Boss', category: 'مالك', level: LEVELS.BOSS, handlesTickets: true },
];

const MOD_RANKS = [
  { name: 'Trial Moderator', category: 'تنفيذي', level: LEVELS.STAFF, perms: 'تايم أوت + حذف رسائل' },
  { name: 'Moderator', category: 'تنفيذي', level: LEVELS.STAFF, perms: 'تحذير + تايم أوت + فويس + حذف + nickname' },
  { name: 'Senior Moderator', category: 'تنفيذي', level: LEVELS.SENIOR, perms: 'كل ما سبق + كيك' },
  { name: 'Admin', category: 'إشرافي', level: LEVELS.SUPERVISOR, perms: 'كل ما سبق + بان + إيموجي' },
  { name: 'Head Of Moderators', category: 'إدارة عليا', level: LEVELS.MANAGEMENT, perms: 'كل ما سبق + إدارة الفريق' },
];

// الإدارة العامة فريق مستقل: لا توجد له ترقيات تلقائية أو شروط Score.
// تعيين الرتبتين يتم فقط عبر Server Manager أو General Manager الحالي.
const GENERAL_MANAGEMENT_RANKS = [
  { name: 'Co General Manager', category: 'إدارة عامة', level: LEVELS.GENERAL_MANAGEMENT, handlesTickets: false, promotable: false },
  { name: 'General Manager', category: 'إدارة عامة', level: LEVELS.GENERAL_MANAGER, handlesTickets: false, promotable: false },
];

// رتب حالات تلقائية لا تُعتبر فريقاً ولا تمنح صلاحيات.
const SYSTEM_ROLES = [
  { name: 'in vacation', label: 'في إجازة', category: 'حالة تلقائية', level: 0 },
];

const TEAMS = {
  support: 'فريق الدعم الفني',
  moderation: 'فريق الإشراف',
  general_management: 'الإدارة العامة للسيرفر',
};

// ===== حالات العضو =====
const STATUS = {
  active: 'نشط',
  inactive: 'غير نشط',
  on_leave: 'بإجازة',
  probation: 'فترة تجريبية',
  suspended: 'موقوف',
  resigned: 'مستقيل',
  removed: 'خرج من السيرفر',
};

// الحالات التي لا تُحتسب في الغياب ولا في ترتيب الأداء
const INACTIVE_STATUSES = ['on_leave', 'suspended', 'resigned', 'removed'];

// ===== قنوات البوت (مصدر واحد للاسم والمعنى) =====
const CHANNEL_META = {
  'staff-faq': { label: 'قاعدة المعرفة', emoji: '📚', desc: 'لوحة FAQ الثابتة' },
  'staff-updates': { label: 'تحديثات القوانين', emoji: '📢', desc: 'إشعارات تعديل FAQ والترقيات' },
  'leave-requests': { label: 'طلبات الإجازة', emoji: '🏖️', desc: 'مراجعة الإجازات بالأزرار' },
  'resignation-requests': { label: 'طلبات الاستقالة', emoji: '📤', desc: 'سري — للإدارة' },
  'staff-logs': { label: 'سجل العمليات', emoji: '🧾', desc: 'كل عملية يقوم بها البوت' },
  'performance-reports': { label: 'التقارير', emoji: '📊', desc: 'اليومي/الأسبوعي/الشهري' },
  'staff-alerts': { label: 'تنبيهات الغياب', emoji: '🚨', desc: 'غياب 96 ساعة + الخاملون' },
  'ticket-logs': { label: 'سجل التكتات', emoji: '🎫', desc: 'التكتات المسجلة' },
  'mod-logs': { label: 'سجل الإشراف', emoji: '🛡️', desc: 'الإجراءات الإشرافية' },
  'manager-review': { label: 'مراجعة الإدارة', emoji: '📈', desc: 'طلبات الترقية' },
  'ticket-source-logs': { label: 'مصدر سجل التكتات الخارجي', emoji: '🤖', desc: 'القناة التي يرسل فيها بوت التكتات رسالة الإغلاق — اختيارية' },
};
const CHANNEL_KEYS = Object.keys(CHANNEL_META).filter(k => k !== 'ticket-source-logs');
const OPTIONAL_CHANNEL_KEYS = ['ticket-source-logs'];

// ===== تصنيفات FAQ =====
const FAQ_CATEGORIES = [
  { id: 1, name: 'قوانين الإدارة', desc: 'القوانين العامة لكلا الفريقين' },
  { id: 2, name: 'قوانين فريق الإشراف', desc: 'قوانين خاصة بالمشرفين' },
  { id: 3, name: 'آلية استلام التكتات', desc: 'خطوات استلام وحل التكتات' },
  { id: 4, name: 'سياسة التصعيد', desc: 'متى وكيف تصعد المشكلة' },
  { id: 5, name: 'أسلوب الرد والتعامل', desc: 'طريقة التعامل مع العملاء' },
  { id: 6, name: 'العقوبات والإنذارات', desc: 'جدول العقوبات' },
  { id: 7, name: 'سياسة الإجازات', desc: 'شروط وأنواع الإجازات' },
  { id: 8, name: 'سياسة الاستقالة', desc: 'خطوات الاستقالة' },
  { id: 9, name: 'نظام الترقيات', desc: 'شروط كل ترقية' },
  { id: 10, name: 'صلاحيات كل رتبة', desc: 'جدول الصلاحيات' },
  { id: 11, name: 'أسئلة شائعة', desc: 'أسئلة متكررة للإداريين' },
];

// ===== النشاط =====
const ACTIVITY_WEIGHTS = { ticket: 0.5, staff: 0.25, moderation: 0.25, general: 0.1 };
const ACTIVITY_TYPE_NAMES = { ticket: 'قنوات التكتات', staff: 'قنوات الإدارة', moderation: 'قنوات الإشراف', general: 'القنوات العامة' };
const SPAM = { minLength: 8, duplicateWindowMs: 2 * 60 * 1000, maxGeneralPerDay: 20 };
const ABSENCE = { dmHours: 72, staffAlertHours: 96, idleDays: 7 };

// ===== الإجازات =====
const LEAVE_TYPES = { normal: 'عادية', emergency: 'طارئة', sick: 'مرضية', study: 'دراسة', special: 'ظروف خاصة' };

// قواعد تفصيلية لكل نوع: الحد للمدة، أدنى مدة إشعار، وسقف متحرك يمنع الإدمان على النوع نفسه.
const LEAVE_RULES = {
  normal:    { emoji: '🏖️', maxDays: 14, minNoticeHours: 48, maxDaysPer90: 30, note: 'خُطط إجازتك مبكراً — تحتاج موافقة مسبقاً بـ 48 ساعة.' },
  emergency: { emoji: '🚨', maxDays: 3,  minNoticeHours: 0,  maxDaysPer90: 7,  note: 'للظروف الطارئة — تُبلّغ الإدارة أولاً ثم تقدّم الطلب خلال 24 ساعة.' },
  sick:      { emoji: '🤒', maxDays: 10, minNoticeHours: 0,  maxDaysPer90: 20, note: 'أرفق تقريراً طبياً عند الإمكان لتفادي الرفض.' },
  study:     { emoji: '📚', maxDays: 7,  minNoticeHours: 24, maxDaysPer90: 14, note: 'لفترات الاختبارات — يُفضّل جدول الجامعة.' },
  special:   { emoji: '🕊️', maxDays: 7,  minNoticeHours: 12, maxDaysPer90: 14, note: 'ظروف عائلية/شخصية طارئة.' },
};

// قيود عامة على دورة الإجازة.
const LEAVE_GLOBAL = {
  maxDays: 30,            // أطول إجازة واحدة
  maxConcurrent: 3,       // أقصى عدد مجازين في اليوم نفسه
  pendingExpireDays: 10,  // يسقط الطلب المعلّق تلقائياً بعد انتهائها دون مراجعة
  minGapDays: 1,          // يوم راحة بين إجازتين معتمدتين
  maxDaysPer90: 30,       // سقف متحرك لكل إداري خلال 90 يوماً
  reminderBeforeDays: 1,  // تذكير قبل البداية
  returnWarnHours: 24,    // تنبيه الإدارة إن لم يعد بعد النهاية
};

// متى تُمنح رتبة `in vacation`
const VACATION_ROLE_TIMING = { at_start: 'عند بداية الإجازة (موصى به)', at_approval: 'فور الموافقة على الطلب' };

// ===== الاستقالات =====
const RESIGNATION_REASONS = {
  workload:   { label: 'ضغط العمل والدوام', emoji: '🔥', retention: true },
  pay:        { label: 'الراتب أو البدلات', emoji: '💰', retention: true },
  personal:   { label: 'ظروف شخصية أو عائلية', emoji: '🏠', retention: false },
  study:      { label: 'الدراسة والتطوير', emoji: '🎓', retention: false },
  management: { label: 'خلاف مع الإدارة', emoji: '⚖️', retention: true },
  burnout:    { label: 'إرهاق أو فقدان دافع', emoji: '🔋', retention: true },
  restructure:{ label: 'تغييرات في السيرفر', emoji: '🧩', retention: true },
  other:      { label: 'سبب آخر', emoji: '📝', retention: false },
};

const RESIGNATION_GLOBAL = {
  noticeDays: 3,          // أقل فترة إشعار
  maxBackdateDays: 0,     // لا تُقبل استقالة بتاريخ ماضٍ
  pendingEscalateDays: 3, // تصعيد الطلب للإدارة العليا بعد
  handoverTasks: [
    'تسليم التكتات المفتوحة',
    'توثيق الحالات المعلقة في السجلات',
    'حذف أي وصوليات أو تكاملات شخصية',
    'كتابة ملاحظة تسليم للإدارة',
  ],
};

// ===== إجراءات الإشراف =====
const MOD_ACTION_TYPES = { warn: 'تحذير', timeout: 'تايم أوت', kick: 'كيك', ban: 'بان', delete: 'حذف رسائل', voice: 'فويس', nickname: 'تغيير الاسم' };

// ===== الملاحظات والإنذارات =====
const NOTE_TYPES = {
  positive: { label: 'ملاحظة إيجابية', emoji: '🟢', points: 5, minLevel: LEVELS.SUPERVISOR },
  negative: { label: 'ملاحظة سلبية', emoji: '🟡', points: -10, minLevel: LEVELS.SUPERVISOR },
};
const WARNING_TYPES = {
  verbal: { label: 'إنذار شفهي', emoji: '🟡', points: -10, freezeDays: 0, minLevel: LEVELS.SUPERVISOR },
  first: { label: 'إنذار أول', emoji: '🟠', points: -20, freezeDays: 14, minLevel: LEVELS.MANAGEMENT },
  second: { label: 'إنذار ثاني', emoji: '🔴', points: -20, freezeDays: 14, minLevel: LEVELS.MANAGEMENT },
  final: { label: 'إنذار أخير', emoji: '🔴', points: -20, freezeDays: 60, suspend: true, minLevel: LEVELS.BOSS },
};

// ===== نقاط الترقية =====
const POINTS = {
  ticket_closed: { label: 'تكت مغلق', support: 2 },
  ticket_rating_5: { label: 'تكت بتقييم 5', support: 5 },
  ticket_rating_4: { label: 'تكت بتقييم 4', support: 2 },
  ticket_rating_low: { label: 'تكت بتقييم 1-2', support: -3 },
  ticket_reopened: { label: 'تكت معاد فتحه', support: -5 },
  mod_action: { label: 'مخالفة معالجة', moderation: 3 },
  fast_response: { label: 'استجابة سريعة', moderation: 5 },
  wrong_decision: { label: 'قرار خاطئ', moderation: -15 },
  week_above_80: { label: 'أسبوع Score فوق 80', all: 10 },
  week_below_50: { label: 'أسبوع Score تحت 50', all: -10 },
  helped_newbie: { label: 'مساعدة عضو جديد', all: 15 },
  complex_case: { label: 'حل تكت/حالة معقدة', all: 10 },
  positive_note: { label: 'ملاحظة إيجابية', all: 5 },
  negative_note: { label: 'ملاحظة سلبية', all: -10 },
  formal_warning: { label: 'إنذار رسمي', all: -20 },
  verbal_warning: { label: 'إنذار شفهي', all: -10 },
  best_of_month: { label: 'أفضل إداري بالشهر', all: 50 },
  absence: { label: 'غياب بدون إجازة', all: -15 },
  spam: { label: 'سبام', all: -10 },
};

// ===== شروط الترقية =====
// approval: مستوى الصلاحية المطلوب للمراجع
// approvals: عدد الموافقات المستقلة المطلوبة (نصاب) — مطابق لما هو معلن للفريق
// windowDays: نافذة احتساب التكتات/المخالفات/التقييم/التواجد (بالأيام)
// warnWindowDays: نافذة احتساب الإنذارات الرسمية
// stableMonths/stableMinScore: «أداء مستقر» عبر تقارير شهرية محفوظة
// maxWrongDecisions: أقصى عدد قرارات خاطئة مسجّلة في النافذة
// requiresHelpedNewbie: يشترط وجود نقاط مساعدة عضو جديد في النافذة

const SUPPORT_PROMOTIONS = [
  {
    from: 'Helper', to: 'Support', months: 2, score: 65, points: 100, tickets: 0, rating: 3.5,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 90,
    minMessages: 50, minActiveDays: 15, requiresSupervisorRating: true,
    approvers: 'مشرف', approvals: 1, approvalLevel: LEVELS.SUPERVISOR,
  },
  {
    from: 'Support', to: 'Support Expert', months: 3, score: 70, points: 250, tickets: 20, rating: 4.0,
    maxWarnings: 1, windowDays: 90, warnWindowDays: 90,
    minMessages: 100, minActiveDays: 20,
    // «Support Office» هنا مستوى 4 — المشرف العادي (3) لا يوافق، فالنص يطابق البوابة.
    approvers: 'Support Office — توقيعان', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Support Expert', to: 'Support Analyst', months: 4, score: 75, points: 500, tickets: 35, rating: 4.2,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 90,
    minMessages: 150, minActiveDays: 20, requiresHelpedNewbie: true,
    approvers: 'Support Office + Boss', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Support Analyst', to: 'Supervisor Manager', months: 6, score: 80, points: 900, tickets: 50, rating: 4.5,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 120,
    minActiveDays: 20, stableMonths: 3, stableMinScore: 70,
    approvers: 'Support Office + Boss', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Supervisor Manager', to: 'Support Office', months: 8, score: 85, points: 1500, tickets: 50, rating: 4.7,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 120,
    stableMonths: 6, stableMinScore: 75,
    approvers: 'Boss', approvals: 1, approvalLevel: LEVELS.BOSS,
  },
];
const MOD_PROMOTIONS = [
  {
    from: 'Trial Moderator', to: 'Moderator', months: 1, score: 60, points: 80, actions: 15,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 90, minActiveDays: 15, maxWrongDecisions: 0,
    // Admin (مستوى 3) مؤهل هنا، وهو ما يطابق النص «Admin أو Head».
    approvers: 'Admin أو Head Of Moderators', approvals: 1, approvalLevel: LEVELS.SUPERVISOR,
  },
  {
    // تنبيه: رتبة Admin في فريق الإشراف = المستوى 3، وبوابة هذه الترقية 4.
    // لذلك الموافقة هنا من الإدارة العليا (توقيعان) ولا يكفي Admin وحده — النص
    // القديم «Admin + Head» كان يوهم بأن أي Admin يوقّع. راجع PROMOTION-SYSTEM-REVIEW.md.
    from: 'Moderator', to: 'Senior Moderator', months: 3, score: 70, points: 200, actions: 30,
    maxWarnings: 1, windowDays: 90, warnWindowDays: 90, minActiveDays: 20, maxWrongDecisions: 2,
    approvers: 'الإدارة العليا — توقيعان', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Senior Moderator', to: 'Admin', months: 4, score: 75, points: 450, actions: 50,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 90, minActiveDays: 22, maxWrongDecisions: 1,
    requireConflictResolution: true,
    approvers: 'Head Of Moderators', approvals: 1, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Admin', to: 'Head Of Moderators', months: 6, score: 85, points: 900, actions: 60,
    maxWarnings: 0, windowDays: 90, warnWindowDays: 120, minActiveDays: 25, maxWrongDecisions: 0,
    stableMonths: 4, stableMinScore: 75,
    approvers: 'Head Of Moderators + إدارة السيرفر', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
];

const COOLDOWNS = { promoted: 15, rejected: 30, warning: 14, suspended: 60 };

/** ضوابط عامة تُستخدم في أكثر من خدمة (ترقيات، تقارير، تقييمات) */
const PROBATION = {
  days: 30,                  // مدة الفترة التجريبية للرتبة الجديدة
  minRatedShare: 60,         // أقل نسبة تكتات مُقيَّمة حتى يُعتمد المتوسط
  minTicketsForRating: 5,    // لا نُقيّم المتوسط قبل هذا العدد من التكتات
};


module.exports = {
  LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, SYSTEM_ROLES, TEAMS, STATUS, INACTIVE_STATUSES, FAQ_CATEGORIES,
  CHANNEL_META, CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS,
  ACTIVITY_WEIGHTS, ACTIVITY_TYPE_NAMES, SPAM, ABSENCE, LEAVE_TYPES, LEAVE_RULES, LEAVE_GLOBAL, VACATION_ROLE_TIMING,
  RESIGNATION_REASONS, RESIGNATION_GLOBAL, MOD_ACTION_TYPES,
  NOTE_TYPES, WARNING_TYPES, POINTS, SUPPORT_PROMOTIONS, MOD_PROMOTIONS, COOLDOWNS, PROBATION,
};
