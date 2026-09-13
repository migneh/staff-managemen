'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../database');

async function createBackup({ reason = 'scheduled' } = {}) {
  if (config.dbPath === ':memory:') throw new Error('لا يمكن إنشاء نسخة احتياطية من قاعدة بيانات الذاكرة.');
  fs.mkdirSync(config.backup.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(config.backup.dir, `staff-${stamp}-${reason}.db`);
  const db = getDb();
  if (typeof db.backup === 'function') await db.backup(target);
  else fs.copyFileSync(config.dbPath, target);

  const files = fs.readdirSync(config.backup.dir)
    .filter(name => /^staff-.*\.db$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(config.backup.dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const file of files.slice(Math.max(1, config.backup.keep))) {
    try { fs.unlinkSync(path.join(config.backup.dir, file.name)); } catch {}
  }
  return target;
}

function listBackups() {
  if (!fs.existsSync(config.backup.dir)) return [];
  return fs.readdirSync(config.backup.dir)
    .filter(name => /^staff-.*\.db$/.test(name))
    .map(name => {
      const file = path.join(config.backup.dir, name);
      const stat = fs.statSync(file);
      return { name, path: file, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

module.exports = { createBackup, listBackups };
