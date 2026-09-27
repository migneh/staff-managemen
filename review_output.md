## Local Review for **uncommitted changes**

### Summary
This review covers enhancements to the staff management system including database schema updates, new service functions for mission templates and recurring tasks, new command modules for staff logs, missions, and onboarding, and enhancements to the my-status command. The leave template functionality infrastructure has been added to the database but requires implementation in the leaves service and command.

### Issues Found
| Severity | File:Line | Issue |
|----------|-----------|-------|
| WARNING | src/services/tasks.js:56 | Duplicate function declaration: `createFromTemplate` |
| WARNING | src/services/tasks.js:89 | Duplicate function declaration: `createRecurring` |
| WARNING | src/services/tasks.js:290 | Duplicate function declaration: `createFromTemplate` |
| WARNING | src/services/tasks.js:323 | Duplicate function declaration: `createRecurring` |
| WARNING | src/commands/staff-logs.js:17 | Typo: `_description` should be `description` |
| WARNING | src/commands/staff-logs.js:18 | Typo: `_description` should be `description` |
| TODO | src/services/leaves.js | Missing leave template management functions |
| TODO | src/commands/leaves.js | Missing leave template subcommands |

### Detailed Findings
**File:** `src/services/tasks.js:56`
- **Confidence:** 100%
- **Problem:** Function `createFromTemplate` is declared at line 56 and again at line 290, causing a "function already declared" runtime error
- **Suggestion:** Remove the duplicate declaration at lines 290-318

**File:** `src/services/tasks.js:89`
- **Confidence:** 100%
- **Problem:** Function `createRecurring` is declared at line 89 and again at line 323, causing a "function already declared" runtime error
- **Suggestion:** Remove the duplicate declaration at lines 323-328

**File:** `src/services/tasks.js:290`
- **Confidence:** 100%
- **Problem:** Duplicate function declaration (see line 56 finding)
- **Suggestion:** Remove this duplicate declaration

**File:** `src/services/tasks.js:323`
- **Confidence:** 100%
- **Problem:** Duplicate function declaration (see line 89 finding)
- **Suggestion:** Remove this duplicate declaration

**File:** `src/commands/staff-logs.js:17`
- **Confidence:** 100%
- **Problem:** Typo in option builder: `set_description` instead of `setDescription`
- **Suggestion:** Change `set_description` to `setDescription`

**File:** `src/commands/staff-logs.js:18`
- **Confidence:** 100%
- **Problem:** Typo in option builder: `set_description` instead of `setDescription`
- **Suggestion:** Change `set_description` to `setDescription`

**File:** `src/services/leaves.js`
- **Confidence:** 100%
- **Problem:** Missing leave template management functions (create, list, get, delete, use templates)
- **Suggestion:** Implement template service functions similar to those in tasks service

**File:** `src/commands/leaves.js`
- **Confidence:** 100%
- **Problem:** Missing leave template subcommands for template management
- **Suggestion:** Add template subcommands to the leaves command (template list, template create, template use, etc.)

### Recommendation
**NEEDS CHANGES** - Issues must be addressed before merging or committing:
1. Fix duplicate function declarations in tasks.js
2. Correct typos in staff-logs.js
3. Implement leave template functionality in leaves service and command