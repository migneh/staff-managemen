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
  'staff-wins': { label: 'إنجازات الفريق', emoji: '🏆', desc: 'ترشيحات وتقدير الزملاء — اختيارية' },
  'support-rating-logs': { label: 'مصدر تقييمات الدعم', emoji: '⭐', desc: 'قناة رسائل بوت تقييم الدعم — قراءة فقط' },
  'ticket-source-logs': { label: 'مصدر سجل التكتات الخارجي', emoji: '🤖', desc: 'القناة التي يرسل فيها بوت التكتات رسالة الإغلاق — اختيارية' },
};
const OPTIONAL_CHANNEL_KEYS = ['ticket-source-logs', 'staff-wins', 'support-rating-logs'];
const CHANNEL_KEYS = Object.keys(CHANNEL_META).filter(k => !OPTIONAL_CHANNEL_KEYS.includes(k));

// ===== تصنيفات FAQ =====
// كانت 11 تصنيفاً؛ أُزيل «قوانين فريق الإشراف» (id 2) ودُمجت مدخلاته في
// «قوانين الإدارة»، ثم أُعيد ترقيم الباقي ليبقى الترقيم متصلاً 1..10.
// ترحيل البيانات القديمة في src/database.js (FAQ_CATEGORY_REMAP) — لا تعدّل
// الأرقام هنا دون تحديث الترحيل، لأنها مخزّنة في faq_entries وfaq_templates.
const FAQ_CATEGORIES = [
  { id: 1, name: 'قوانين الإدارة', desc: 'القوانين العامة لكلا الفريقين' },
  { id: 2, name: 'آلية استلام التكتات', desc: 'خطوات استلام وحل التكتات' },
  { id: 3, name: 'سياسة التصعيد', desc: 'متى وكيف تصعد المشكلة' },
  { id: 4, name: 'أسلوب الرد والتعامل', desc: 'طريقة التعامل مع العملاء' },
  { id: 5, name: 'العقوبات والإنذارات', desc: 'جدول العقوبات' },
  { id: 6, name: 'سياسة الإجازات', desc: 'شروط وأنواع الإجازات' },
  { id: 7, name: 'سياسة الاستقالة', desc: 'خطوات الاستقالة' },
  { id: 8, name: 'نظام الترقيات', desc: 'شروط كل ترقية' },
  { id: 9, name: 'صلاحيات كل رتبة', desc: 'جدول الصلاحيات' },
  { id: 10, name: 'أسئلة شائعة', desc: 'أسئلة متكررة للإداريين' },
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
  annualDays: 0,          // رصيد سنوي لكل إداري (0 = بلا سقف سنوي)
  teamCover: 1,           //أدنى تغطية مقبولة لكل فريق خلال فترة الإجازة
  enforceTeamCover: false,// منع الاعتماد عند كسر تغطية الفريق (افتراضياً تحذير فقط)
  pendingEscalateHours: 24, // تصعيد الطلب المعلّق لفريق المراجعة بعد هذه المدة
  workdayCounting: false, // احتساب أيام العمل فقط بدل الأيام التقويمية
  weeklyOff: [],          // أيام الراحة الأسبوعية عند تفعيل احتساب أيام العمل
};

// أسماء أيام الأسبوع بنفس ترقيم JavaScript (0 = الأحد)
const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

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

// ===== نقاط الترقية (محدثة حسب النظام v3.0) =====
const POINTS = {
  // إيجابي - تكتات
  ticket_closed: { label: 'تكت مغلق', support: 2 },
  ticket_rating_5: { label: 'تكت بتقييم 5', support: 5 },
  ticket_rating_4: { label: 'تكت بتقييم 4', support: 2 },
  ticket_rating_low: { label: 'تكت بتقييم 1-2', support: -3 },
  ticket_reopened: { label: 'تكت معاد فتحه', support: -5 },
  
  // إيجابي - مخالفات/إشراف
  mod_action: { label: 'مخالفة معالجة', moderation: 3 },
  fast_response: { label: 'استجابة سريعة < 5 د', moderation: 5 },
  wrong_decision: { label: 'قرار خاطئ', moderation: -15 },
  
  // أسبوعي/شهري
  week_above_80: { label: 'أسبوع Score فوق 80', all: 10 },
  week_below_50: { label: 'أسبوع Score تحت 50', all: -10 },
  
  // تعاون/مساعدة
  helped_newbie: { label: 'مساعدة عضو جديد', all: 15 },
  shoutout: { label: 'تقدير من زميل', all: 5 },
  complex_case: { label: 'حل تكت/حالة معقدة', all: 10 },
  
  // ملاحظات
  positive_note: { label: 'ملاحظة إيجابية', all: 5 },
  negative_note: { label: 'ملاحظة سلبية', all: -10 },
  
  // إنذارات
  formal_warning: { label: 'إنذار رسمي', all: -20 },
  verbal_warning: { label: 'إنذار شفهي', all: -10 },
  
  // مكافآت
  best_of_month: { label: 'أفضل إداري بالشهر', all: 50 },
  retention_3m: { label: 'استمرارية 3 أشهر', all: 30 },
  retention_6m: { label: 'استمرارية 6 أشهر', all: 75 },
  retention_12m: { label: 'استمرارية 12 شهر', all: 200 },
  
  // خصومات
  absence: { label: 'غياب بدون إجازة', all: -15 },
  spam: { label: 'سبام', all: -10 },
  long_leave_15_21: { label: 'إجازة طويلة 15-21 يوم', all: -5 },
  long_leave_22_28: { label: 'إجازة طويلة 22-28 يوم', all: -10 },
  long_leave_29_30: { label: 'إجازة طويلة 29-30 يوم', all: -15 },
  
  // منح يدوي من الإدارة (القيمة تُمرَّر صراحةً عند المنح، وهذي التسميات للسجل والعرض)
  manual_boost: { label: 'منح يدوي — تحفيز', all: 0 },
  manually_helped: { label: 'منح يدوي — مساعدة', all: 0 },
  manual_correction: { label: 'منح يدوي — تصحيح رصيد', all: 0 },
  manual_violation: { label: 'خصم يدوي — مخالفة', all: 0 },
};

// ===== شروط الترقية (محدثة حسب النظام v3.0) =====
// approval: مستوى الصلاحية المطلوب للمراجع
// approvals: عدد الموافقات المستقلة المطلوبة (نصاب) — مطابق لما هو معلن للفريق
// windowDays: نافذة احتساب التكتات/المخالفات/التقييم/التواجد (بالأيام)
// warnWindowDays: نافذة احتساب الإنذارات الرسمية
// stableMonths/stableMinScore: «أداء مستقر» عبر تقارير شهرية محفوظة
// maxWrongDecisions: أقصى عدد قرارات خاطئة مسجّلة في النافذة
// requiresHelpedNewbie: يشترط وجود نقاط مساعدة عضو جديد في النافذة
// requiresSupervisorRating: يشترط تقييم مشرف حديث (خلال 90 يوم)
// requiresConflictResolution: يشترط حل نزاعات

const SUPPORT_PROMOTIONS = [
  {
    from: 'Helper', to: 'Support', months: 2, score: 65, points: 100, tickets: 0, rating: 3.5,
    maxWarnings: 0, windowDays: 180, warnWindowDays: 180,
    minActiveDays: 15, minMessages: null, requiresSupervisorRating: true, requiresHelpedNewbie: false,
    approvers: 'مشرف واحد', approvals: 1, approvalLevel: LEVELS.SUPERVISOR,
  },
  {
    from: 'Support', to: 'Support Expert', months: 3, score: 70, points: 250, tickets: 20, rating: 4.0,
    maxWarnings: 1, windowDays: 180, warnWindowDays: 180,
    minActiveDays: 20, minMessages: 100, requiresHelpedNewbie: false,
    approvers: 'مشرف + Support Office', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Support Expert', to: 'Support Analyst', months: 4, score: 75, points: 500, tickets: 35, rating: 4.2,
    maxWarnings: 0, windowDays: 180, warnWindowDays: 180,
    minActiveDays: 20, minMessages: 150, requiresHelpedNewbie: true,
    approvers: 'Support Office + Boss', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Support Analyst', to: 'Supervisor Manager', months: 6, score: 80, points: 900, tickets: 50, rating: 4.5,
    maxWarnings: 0, windowDays: 180, warnWindowDays: 180,
    minActiveDays: 20, minMessages: null, stableMonths: 3, stableMinScore: 70, requiresHelpedNewbie: false,
    approvers: 'Support Office + Boss', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Supervisor Manager', to: 'Support Office', months: 8, score: 85, points: 1500, tickets: 50, rating: 4.7,
    maxWarnings: 0, windowDays: 180, warnWindowDays: 180,
    minActiveDays: 20, minMessages: null, stableMonths: 6, stableMinScore: 75, requiresHelpedNewbie: false,
    approvers: 'Boss فقط', approvals: 1, approvalLevel: LEVELS.BOSS,
  },
];
const MOD_PROMOTIONS = [
  {
    from: 'Trial Moderator', to: 'Moderator', months: 1, score: 60, points: 80, actions: 15,
    maxWarnings: 0, windowDays: 30, warnWindowDays: 30, minActiveDays: 15, maxWrongDecisions: 0,
    requiresConflictResolution: false,
    approvers: 'Admin أو Head Of Moderators', approvals: 1, approvalLevel: LEVELS.SUPERVISOR,
  },
  {
    from: 'Moderator', to: 'Senior Moderator', months: 3, score: 70, points: 200, actions: 30,
    maxWarnings: 1, windowDays: 90, warnWindowDays: 90, minActiveDays: 20, maxWrongDecisions: 2,
    requiresConflictResolution: false,
    approvers: 'Admin + Head Of Moderators', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Senior Moderator', to: 'Admin', months: 4, score: 75, points: 450, actions: 50,
    maxWarnings: 0, windowDays: 120, warnWindowDays: 120, minActiveDays: 22, maxWrongDecisions: 1,
    requiresConflictResolution: true,
    approvers: 'Head Of Moderators', approvals: 1, approvalLevel: LEVELS.MANAGEMENT,
  },
  {
    from: 'Admin', to: 'Head Of Moderators', months: 6, score: 85, points: 900, actions: 60,
    maxWarnings: 0, windowDays: 180, warnWindowDays: 180, minActiveDays: 25, maxWrongDecisions: 0,
    requiresConflictResolution: true, stableMonths: 4, stableMinScore: 75,
    approvers: 'Head الحالي + إدارة السيرفر', approvals: 2, approvalLevel: LEVELS.MANAGEMENT,
  },
];

const COOLDOWNS = { 
  // تبريد متدرج حسب الرتبة الجديدة
  promoted_helper: 15,     // بعد ترقية لـ Support
  promoted_support: 30,    // بعد ترقية لـ Expert
  promoted_expert: 45,     // بعد ترقية لـ Analyst
  promoted_analyst: 60,    // بعد ترقية لـ Supervisor
  promoted_supervisor: 90, // بعد ترقية لـ Office/Head
  rejected: 30,            // بعد رفض الترقية
  warning: 14,             // بعد إنذار
  suspended: 60,           // بعد إيقاف
};

/** ضوابط عامة تُستخدم في أكثر من خدمة (ترقيات، تقارير، تقييمات) */
const PROBATION = {
  days: 30,                  // مدة الفترة التجريبية للرتبة الجديدة
  minRatedShare: 60,         // أقل نسبة تكتات مُقيَّمة حتى يُعتمد المتوسط
  minTicketsForRating: 5,    // لا نُقيّم المتوسط قبل هذا العدد من التكتات
};

// أوزان Score قابلة للضبط — مجموع كل فريق يجب أن يساوي 100.
// Helper (بدون تكتات): شات 25 | تواجد 25 | تفاعل 25 | مشرف 25
// Support فأعلى: تكتات 30 | سرعة+تقييم 25 | شات 25 | تواجد 20
// الإشراف (كل الرتب): مخالفات 30 | سرعة (من السجلات) 25 | تواجد 25 | التزام 20
const SCORE_WEIGHTS = {
  helper: { chat: 25, presence: 25, teamInteraction: 25, supervisorRating: 25 },
  support: { tickets: 30, speed: 25, chat: 25, presence: 20 },
  moderation: { actions: 30, speed: 25, activity: 25, commitment: 20 },
};


module.exports = {
  LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, SYSTEM_ROLES, TEAMS, STATUS, INACTIVE_STATUSES, FAQ_CATEGORIES,
  CHANNEL_META, CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS,
  ACTIVITY_WEIGHTS, ACTIVITY_TYPE_NAMES, SPAM, ABSENCE, LEAVE_TYPES, LEAVE_RULES, LEAVE_GLOBAL, VACATION_ROLE_TIMING, WEEKDAYS_AR,
  RESIGNATION_REASONS, RESIGNATION_GLOBAL, MOD_ACTION_TYPES,
  NOTE_TYPES, WARNING_TYPES, POINTS, SUPPORT_PROMOTIONS, MOD_PROMOTIONS, COOLDOWNS, PROBATION, SCORE_WEIGHTS,
};
