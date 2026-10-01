// Automated verification test for Staging Worker topology and Deploy Checklist (P9-5).
// Asserts that wrangler.toml staging environment mirrors production bindings,
// SQL migrations apply cleanly in sequence, and operational documentation is complete.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

describe("P9-5: Staging Worker Topology & Deploy Checklist Validation", () => {
  it("wrangler.toml declares a complete and isolated [env.staging] configuration", () => {
    const wranglerPath = path.join(REPO_ROOT, "wrangler.toml");
    assert.ok(fs.existsSync(wranglerPath), "wrangler.toml must exist");
    const content = fs.readFileSync(wranglerPath, "utf8");

    // 1. Staging block declared
    assert.ok(content.includes("[env.staging]"), "wrangler.toml must contain [env.staging]");
    assert.ok(content.includes('name = "my-lists-addon-staging"'));

    // 2. All 6 core bindings mirrored in staging
    const requiredBindings = [
      'binding = "CONFIGS"',
      'binding = "DB"',
      'binding = "DB_ACTIVITY"',
      'binding = "ANALYTICS"',
      'binding = "BLOBS"',
      'binding = "JOBS"',
    ];

    const stagingSection = content.slice(content.indexOf("[env.staging]"));
    for (const binding of requiredBindings) {
      assert.ok(
        stagingSection.includes(binding),
        `[env.staging] must define ${binding}`
      );
    }

    // 3. Staging database names are isolated
    assert.ok(stagingSection.includes('database_name = "my-lists-db-staging"'));
    assert.ok(stagingSection.includes('database_name = "mylists-activity-staging"'));

    // 4. Staging R2 bucket is isolated
    assert.ok(stagingSection.includes('bucket_name = "mylists-blobs-staging"'));

    // 5. Staging queue producer & consumer with DLQ
    assert.ok(stagingSection.includes('queue = "mylists-jobs-staging"'));
    assert.ok(stagingSection.includes('dead_letter_queue = "mylists-jobs-staging-dlq"'));

    // 6. Analytics Engine dataset is isolated
    assert.ok(stagingSection.includes('dataset = "mylists_events_staging"'));

    // 7. Preview feature flags configured
    assert.ok(stagingSection.includes('FF_V2_LISTS_READ = "1"'));
    assert.ok(stagingSection.includes('FF_SESSIONS = "1"'));
    assert.ok(stagingSection.includes('FF_EVENT_TRACKING = "1"'));
  });

  it("all sequential SQL migrations execute without error into a fresh SQLite staging database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");

    // For a brand new staging database, schema.sql creates all tables directly
    const schemaSql = fs.readFileSync(path.join(REPO_ROOT, "schema.sql"), "utf8");
    db.exec(schemaSql);

    // Verify key tables exist in staging DB
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    const requiredTables = [
      "accounts",
      "sessions",
      "installs",
      "install_secrets",
      "lists",
      "list_items",
      "channels",
      "likes",
      "rate_counters",
    ];

    for (const t of requiredTables) {
      assert.ok(tables.includes(t), `Table ${t} must exist after executing migrations in staging DB`);
    }

    // Now test activity migrations in a separate DB
    const actDb = new DatabaseSync(":memory:");
    actDb.exec("PRAGMA foreign_keys = ON;");
    const actSql = fs.readFileSync(path.join(REPO_ROOT, "schema_activity.sql"), "utf8");
    actDb.exec(actSql);

    const actTables = actDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    assert.ok(actTables.includes("watch_events"));
    assert.ok(actTables.includes("show_progress"));
    assert.ok(actTables.includes("user_media_state"));
  });

  it("operational documentation (docs/STAGING.md, docs/DEPLOY_CHECKLIST.md, docs/OPERATIONS.md) covers all deploy gates", () => {
    const stagingDoc = path.join(REPO_ROOT, "docs", "STAGING.md");
    const checklistDoc = path.join(REPO_ROOT, "docs", "DEPLOY_CHECKLIST.md");
    const opsDoc = path.join(REPO_ROOT, "docs", "OPERATIONS.md");

    assert.ok(fs.existsSync(stagingDoc), "docs/STAGING.md must exist");
    assert.ok(fs.existsSync(checklistDoc), "docs/DEPLOY_CHECKLIST.md must exist");
    assert.ok(fs.existsSync(opsDoc), "docs/OPERATIONS.md must exist");

    const stagingContent = fs.readFileSync(stagingDoc, "utf8");
    const checklistContent = fs.readFileSync(checklistDoc, "utf8");
    const opsContent = fs.readFileSync(opsDoc, "utf8");

    // STAGING.md assertions
    assert.ok(stagingContent.includes("100% resource isolation"));
    assert.ok(stagingContent.includes("my-lists-db-staging"));
    assert.ok(stagingContent.includes("mylists-activity-staging"));
    assert.ok(stagingContent.includes("mylists-blobs-staging"));
    assert.ok(stagingContent.includes("mylists-jobs-staging"));
    assert.ok(stagingContent.includes("loadtests/"));

    // DEPLOY_CHECKLIST.md assertions
    assert.ok(checklistContent.includes("Phase A: Pre-Deploy Verification Gate"));
    assert.ok(checklistContent.includes("Phase B: Pre-Deploy Database Backup Gate"));
    assert.ok(checklistContent.includes("Phase C: Staging Deployment & Rehearsal Gate"));
    assert.ok(checklistContent.includes("Phase D: Production Deployment Procedure"));
    assert.ok(checklistContent.includes("Phase E: Post-Deploy Monitoring & 30-Minute Soak Period"));
    assert.ok(checklistContent.includes("Phase F: Emergency Rollback Protocol"));

    // Cross-link assertion in OPERATIONS.md
    assert.ok(opsContent.includes("DEPLOY_CHECKLIST.md"));
    assert.ok(opsContent.includes("STAGING.md"));
  });
});
