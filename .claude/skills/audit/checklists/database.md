# Database and data audit checklist
Production data is not reachable from a cloud session. Work from the schema,
migrations and code; build a local SQLite copy from them to test queries.

| Area | What it examines | How to check |
|---|---|---|
| Data Loss | Operations that could accidentally delete or overwrite data | Every DELETE, overwrite, reset, purge and import; what happens on a half-finished request; "save" that replaces a whole record |
| Backup & Recovery | Whether data can actually be restored | Backup workflow, what it covers (every database, KV, R2?), retention, and whether the restore steps are written down and were ever tested |
| Data Integrity | Missing constraints and inconsistent records | NOT NULL, UNIQUE, CHECK, defaults; code that relies on rules the database does not enforce |
| Data Relationships | Incorrect relationships and foreign keys | Foreign keys and cascades vs what account deletion and cleanup code expect |
| Database Schema | Incorrect or inconsistent database structures | Schema files vs migrations vs the columns the code actually reads and writes |
| Migrations | Broken, incomplete, or unsafe migrations | Apply all migrations in order to an empty SQLite DB; compare to the schema files; look for destructive steps and ones that can't be re-run |
| Query Efficiency | Inefficient database access | `EXPLAIN QUERY PLAN` for hot queries; missing indexes; SELECT * on wide tables; queries inside loops |
| Data Consistency | Whether different parts of the application agree | Same data in D1, KV, caches and the browser: who wins, and can they drift apart for good? |
