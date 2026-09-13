'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff_members (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  team TEXT NOT NULL,            -- support | moderation
  rank TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  rank_since TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT,
  absence_alert_level INTEGER NOT NULL DEFAULT 0, -- 0 none, 1 dm sent, 2 staff alert sent
  probation_exempt INTEGER NOT NULL DEFAULT 0,
  supervisor_rating INTEGER,     -- تقييم المشرف (5-25)
  team_interaction INTEGER,      -- التفاعل مع الفريق (5-25)
  response_speed INTEGER,        -- سرعة الاستجابة للإشراف (5-25)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,     -- ticket | staff | moderation | general
  weight REAL NOT NULL,
  content_hash TEXT,
  day TEXT NOT NULL,              -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user_day ON activity_logs(user_id, day);

CREATE TABLE IF NOT EXISTS ticket_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  ticket_owner TEXT NOT NULL,
  claimer TEXT NOT NULL,
  closer TEXT NOT NULL,
  rating INTEGER,
  duration INTEGER,
  logged_by TEXT NOT NULL,
  reopened INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | external_log
  source_message_id TEXT,
  source_channel_id TEXT,
  source_url TEXT,
  ticket_url TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_claimer ON ticket_metrics(claimer, closed_at);

CREATE TABLE IF NOT EXISTS mod_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moderator_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_mod ON mod_actions(moderator_id, created_at);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | ended
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  reminders_sent TEXT NOT NULL DEFAULT '', -- csv: start,end,overdue
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS resignations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  last_day TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | on_hold
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  team TEXT,
  rank TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  warning_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  note_type TEXT NOT NULL,       -- positive | negative
  content TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_important INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,          -- create | edit | delete
  title TEXT,
  content TEXT,
  category_id INTEGER,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  entry_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE IF NOT EXISTS faq_panels (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  from_rank TEXT NOT NULL,
  to_rank TEXT NOT NULL,
  note TEXT,
  snapshot TEXT,                 -- JSON لحالة الشروط وقت الطلب
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS promotion_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason_key TEXT NOT NULL,
  reason TEXT,
  ref_type TEXT,
  ref_id TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_points_user ON promotion_points(user_id);

CREATE TABLE IF NOT EXISTS promotion_cooldowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  cooldown_type TEXT NOT NULL,   -- promoted | rejected | warning | suspended
  until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,     -- daily | weekly | monthly
  period TEXT NOT NULL,
  data TEXT NOT NULL,            -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  details TEXT,
  channel_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_id, created_at);

CREATE TABLE IF NOT EXISTS staff_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL DEFAULT 'general', -- general | onboarding | follow_up
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  assigned_by TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON staff_tasks(user_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function migrate(database) {
  // ترقية قواعد البيانات القديمة بدون فقدان أي سجل.
  const columns = new Set(database.prepare('PRAGMA table_info(ticket_metrics)').all().map(c => c.name));
  const additions = [
    ['source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['source_message_id', 'TEXT'],
    ['source_channel_id', 'TEXT'],
    ['source_url', 'TEXT'],
    ['ticket_url', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE ticket_metrics ADD COLUMN ${name} ${definition}`);
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_source_message ON ticket_metrics(source_message_id) WHERE source_message_id IS NOT NULL');
}

function getDb() {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (config.dbPath !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** لأغراض الاختبار */
function openMemoryDb() {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { getDb, openMemoryDb };
