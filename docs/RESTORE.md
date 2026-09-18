# 🛟 استرجاع قاعدة البيانات — تدريب موثّق

> «نسخة احتياطية لم تُختبر ليست نسخة احتياطية.» هذا الملف يشرح كيف تسترجع بيانات
> البوت فعلياً، ويُفترض أن يُنفَّذ التدريب **مرة كل ثلاثة شهور** ويُسجَّل نتيجته في
> `backup_checks` (كل `/backup` و`/backup-list` يسجّلان فحصاً جديداً).

---

## ١) أين النسخ؟

| المصدر | المسار | ملاحظة |
|---|---|---|
| النسخ المجدولة | `backups/staff-<timestamp>-scheduled.db` | كل يوم 00:15 |
| النسخ اليدوية | `backups/staff-<timestamp>-manual-<userId>.db` | عبر `/backup` |
| الملف الحيّ | `data/staff.db` (أو `DB_PATH`) | لا تنسخه وهو قيد الكتابة يدوياً |

عدد النسخ المحفوظة يُضبط بـ `BACKUP_KEEP` (الافتراضي 14)، والمجلد بـ `BACKUP_DIR`.

## ٢) فحص سريع بلا استرجاع (10 ثوانٍ)

```bash
# من داخل السيرفر
sqlite3 backups/staff-*.db "PRAGMA integrity_check;" | head -1     # يجب أن يُطبع: ok
sqlite3 backups/staff-*.db "SELECT COUNT(*) FROM staff_members;"
```

أو من ديسكورد: `/backup-list` — يعرض أحدث النسخ مع نتيجة فحص السلامة الأخيرة
(`backup_checks`). البوت يفشل الطلب صراحةً إن أنشأ نسخة لم تجتز الفحص.

## ٣) تدريب الاسترجاع (أقل من 15 دقيقة)

```bash
# 1) أوقف البوت (حتى لا يكتب أحد على الملف الحيّ)
sudo systemctl stop staff-bot        # أو: pkill -f "node src/index.js"

# 2) احتفظ بالنسخة الحالية كي يمكن الرجوع عنها
mv data/staff.db data/staff.db.before-restore

# 3) استرجع النسخة المطلوبة
cp backups/staff-2026-09-18T00-15-00-000Z-scheduled.db data/staff.db

# 4) تحقّق قبل التشغيل
sqlite3 data/staff.db "PRAGMA integrity_check;"
sqlite3 data/staff.db "SELECT COUNT(*) FROM staff_members; SELECT COUNT(*) FROM activity_logs;"

# 5) شغّل البوت وراقب
npm start        # ثم في ديسكورد: /system-status (المهام + الحجم + آخر نسخة)
```

**قائمة تحقق النجاح:**
- [ ] `PRAGMA integrity_check` = `ok`
- [ ] عدد الإداريين مطابق للتوقّع
- [ ] `/system-status` يعرض المهام المجدولة تعمل وآخر تشغيل بلا أخطاء
- [ ] `/leaderboard` و`/team-report` يعطيان أرقاماً معقولة (ليست صفراً)
- [ ] `/my-record` لأحد الأعضاء يعرض سجله

## ٤) استرجاع جزئي (جدول واحد فقط)

لا تسترجع القاعدة كاملة إن كان المفقود جدولاً واحداً:

```bash
cp backups/staff-<ts>-scheduled.db /tmp/old.db
sqlite3 /tmp/old.db ".mode insert staff_members" "SELECT * FROM staff_members;" > /tmp/staff.sql
# راجع الملف ثم:
sqlite3 data/staff.db < /tmp/staff.sql
```

> استخدم `INSERT OR REPLACE` إن كان الجدول فيه صفوف محدّثة، وراجع النتيجة بـ
> `SELECT COUNT(*)` قبل إعادة تشغيل البوت.

## ٥) نسخة خارج السيرفر (موصى به)

النسخ على نفس القرص تحمي من خطأ بشري، لا من تلف القرص. ارفعها خارجياً:

```bash
# مثال rclone: نسخ مجلد النسخ إلى تخزين سحابي
rclone copy backups/ remote:staff-bot-backups/ --max-age 30d

# أو مهمة cron يومية بعد نسخة البوت (00:20)
20 0 * * * rclone copy /opt/staff-bot/backups/ remote:staff-bot-backups/ >> /var/log/staff-backup.log 2>&1
```

## ٦) ماذا نفعل إن فشل الفحص؟

1. **لا تحذف** النسخة الفاشلة؛ انقلها إلى `backups/corrupt/` للتشخيص.
2. أنشئ نسخة جديدة فوراً: `/backup`.
3. إن فشلت النسخة الجديدة كذلك، فالمشكلة في الملف الحيّ: أوقف الكتابة على القاعدة،
   خُذ نسخة من `data/staff.db`، ثم `sqlite3 data/staff.db "VACUUM INTO '/tmp/rebuilt.db'"`.
4. أعِد بناء الملف عبر الاسترجاع أعلاه من آخر نسخة سليمة، ثم شغّل
   `/maintenance` (بوضع المعاينة أولاً) لتنظيف السجلات القديمة.
