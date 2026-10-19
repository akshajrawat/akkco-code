import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
    CURRENT_SCHEMA_VERSION,
    migrateDatabase,
    MigrationError,
    SqliteConversationStore,
} from "../src/index.js";
import { executeWithRetry, getDefaultMigrationsDir } from "../src/sqlite/migrations.js";

test("Fresh database receives current schema", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    assert.equal(await store.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    // Verify schema_migrations table structure and metadata
    // @ts-expect-error accessing private db for test assertion
    const db = store.getDb();
    const migrations = db
        .prepare(
            "SELECT version, filename, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
        )
        .all() as {
        version: number;
        filename: string;
        checksum: string;
        applied_at: string;
    }[];

    assert.equal(migrations.length, CURRENT_SCHEMA_VERSION);
    assert.equal(migrations[0].version, 1);
    assert.equal(migrations[0].filename, "0001_initial.sql");
    assert.equal(typeof migrations[0].checksum, "string");
    assert.equal(migrations[0].checksum.length, 64);
    assert.ok(migrations[0].applied_at);

    if (CURRENT_SCHEMA_VERSION >= 2) {
        assert.equal(migrations[1].version, 2);
        assert.equal(migrations[1].filename, "0002_context_summaries.sql");
    }

    // Verify business tables exist
    const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
            name: string;
        }[]
    ).map((t) => t.name);

    assert.ok(tables.includes("sessions"));
    assert.ok(tables.includes("transcript_items"));
    assert.ok(tables.includes("memory_documents"));
    assert.ok(tables.includes("context_summaries"));

    // Verify indexes exist
    const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as {
            name: string;
        }[]
    ).map((i) => i.name);

    assert.ok(indexes.includes("idx_transcript_items_session_seq"));
    assert.ok(indexes.includes("idx_memory_documents_session"));
    assert.ok(indexes.includes("idx_memory_documents_identity"));
    assert.ok(indexes.includes("idx_context_summaries_session_range"));

    await store.close();
});

test("Unsupported legacy database is rejected with actionable error", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-legacy-"));
    const dbPath = join(tmpDir, "legacy.db");

    try {
        // 1. Manually create an old experimental database with two-column schema_migrations
        const oldDb = new DatabaseSync(dbPath);
        oldDb.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            INSERT INTO schema_migrations (version, applied_at)
            VALUES (1, '2026-10-01T10:00:00.000Z');

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);
        oldDb.close();

        // 2. Open with new SqliteConversationStore - must reject with actionable reset error
        const store = new SqliteConversationStore({ dbPath });
        await assert.rejects(
            async () => {
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("Unsupported legacy database schema detected"));
                assert.ok(err.message.includes("manual development reset is required"));
                assert.ok(err.message.includes("akkco.db"));
                return true;
            },
        );

        // 3. Verify the file was NOT deleted or dropped
        const checkDb = new DatabaseSync(dbPath);
        const tables = checkDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
            .get();
        assert.ok(tables);
        checkDb.close();
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Repeated initialization is idempotent", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-idempotent-"));
    const dbPath = join(tmpDir, "idempotent.db");

    try {
        const store1 = new SqliteConversationStore({ dbPath });
        await store1.initialize();
        assert.equal(await store1.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
        await store1.close();

        // Re-open same db
        const store2 = new SqliteConversationStore({ dbPath });
        await store2.initialize();
        // Call initialize twice on same instance
        await store2.initialize();
        assert.equal(await store2.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

        // Explicitly call migrateDatabase again
        // @ts-expect-error accessing private db for test assertion
        const res = await migrateDatabase(store2.getDb());
        assert.equal(res.currentVersion, CURRENT_SCHEMA_VERSION);
        assert.equal(res.appliedVersions.length, 0);

        await store2.close();
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Pending migrations execute in order", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-order-"));
    const migrationsDir = join(tmpDir, "migrations");
    const dbPath = join(tmpDir, "ordered.db");

    try {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(migrationsDir, { recursive: true });

        // Copy 0001_initial.sql
        const initialSql = await readFile(
            join(getDefaultMigrationsDir(), "0001_initial.sql"),
            "utf8",
        );
        await writeFile(join(migrationsDir, "0001_initial.sql"), initialSql);

        // Add 0002_add_tags.sql
        await writeFile(
            join(migrationsDir, "0002_add_tags.sql"),
            `CREATE TABLE test_tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );`,
        );

        // Add 0003_add_session_tags.sql
        await writeFile(
            join(migrationsDir, "0003_add_session_tags.sql"),
            `CREATE TABLE test_session_tags (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES test_tags(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, tag_id)
            );`,
        );

        const store = new SqliteConversationStore({ dbPath, migrationsDir });
        await store.initialize();

        assert.equal(await store.getSchemaVersion(), 3);

        // @ts-expect-error accessing private db for test assertion
        const db = store.getDb();
        const applied = db
            .prepare("SELECT version, filename FROM schema_migrations ORDER BY version ASC")
            .all() as { version: number; filename: string }[];

        assert.equal(applied.length, 3);
        assert.equal(applied[0].version, 1);
        assert.equal(applied[0].filename, "0001_initial.sql");
        assert.equal(applied[1].version, 2);
        assert.equal(applied[1].filename, "0002_add_tags.sql");
        assert.equal(applied[2].version, 3);
        assert.equal(applied[2].filename, "0003_add_session_tags.sql");

        // Now append migration 4 to the directory
        await writeFile(
            join(migrationsDir, "0004_add_audit_log.sql"),
            `CREATE TABLE test_audit_log (
                id TEXT PRIMARY KEY,
                note TEXT NOT NULL
            );`,
        );

        const result = await migrateDatabase(db, { migrationsDir });
        assert.equal(result.currentVersion, 4);
        assert.deepEqual(result.appliedVersions, [4]);

        assert.equal(await store.getSchemaVersion(), 4);

        await store.close();
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Failed migration rolls back entirely", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-rollback-"));
    const migrationsDir = join(tmpDir, "migrations");
    const dbPath = join(tmpDir, "rollback.db");

    try {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(migrationsDir, { recursive: true });

        // Copy 0001_initial.sql
        const initialSql = await readFile(
            join(getDefaultMigrationsDir(), "0001_initial.sql"),
            "utf8",
        );
        await writeFile(join(migrationsDir, "0001_initial.sql"), initialSql);

        // Add 0002_faulty.sql with canary table then invalid statement
        await writeFile(
            join(migrationsDir, "0002_faulty.sql"),
            `CREATE TABLE rollback_canary (id TEXT PRIMARY KEY);
            SYNTAX ERROR IN THIS STATEMENT;`,
        );

        const store = new SqliteConversationStore({ dbPath, migrationsDir });
        await assert.rejects(
            async () => {
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("0002_faulty.sql"));
                return true;
            },
        );

        // Inspect database state with raw connection
        const db = new DatabaseSync(dbPath);
        const canaryTable = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_canary'",
            )
            .get();
        assert.equal(canaryTable, undefined); // Rolled back!

        const maxVer = db
            .prepare("SELECT MAX(version) as version FROM schema_migrations")
            .get() as {
            version: number;
        };
        assert.equal(maxVer.version, 1); // Stayed at version 1!

        db.close();
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Previously applied migration checksum mismatch is detected", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-checksum-"));
    const migrationsDir = join(tmpDir, "migrations");
    const dbPath = join(tmpDir, "checksum.db");

    try {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(migrationsDir, { recursive: true });

        // Copy 0001_initial.sql
        const initialSql = await readFile(
            join(getDefaultMigrationsDir(), "0001_initial.sql"),
            "utf8",
        );
        await writeFile(join(migrationsDir, "0001_initial.sql"), initialSql);

        const store = new SqliteConversationStore({ dbPath, migrationsDir });
        await store.initialize();
        await store.close();

        // Mutate 0001_initial.sql in migrations directory
        await writeFile(
            join(migrationsDir, "0001_initial.sql"),
            initialSql + "\n-- MODIFIED_CONTENT\n",
        );

        const store2 = new SqliteConversationStore({ dbPath, migrationsDir });
        await assert.rejects(
            async () => {
                await store2.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("checksum mismatch"));
                assert.ok(err.message.includes("0001_initial.sql"));
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Unsupported future database version is rejected", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-future-"));
    const dbPath = join(tmpDir, "future.db");

    try {
        const store = new SqliteConversationStore({ dbPath });
        await store.initialize();

        // Insert a future migration record (e.g. version 999)
        // @ts-expect-error accessing private db for test assertion
        const db = store.getDb();
        db.prepare(
            `INSERT INTO schema_migrations (version, filename, checksum, applied_at)
             VALUES (999, '0999_future.sql', 'deadbeef00000000000000000000000000000000000000000000000000000000', ?)`,
        ).run(new Date().toISOString());

        await store.close();

        // Try initializing a new store with current code (which only knows up to version 1)
        const store2 = new SqliteConversationStore({ dbPath });
        await assert.rejects(
            async () => {
                await store2.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(
                    err.message.includes(
                        "Database schema version 999 is newer than supported version",
                    ),
                );
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Foreign-key cascade behavior works", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    await store.saveSession({ id: "cascade-sess-1" });
    await store.saveTranscriptItems("cascade-sess-1", [
        { sequence: 0, type: "user", payload: "{}" },
        { sequence: 1, type: "assistant", payload: "{}" },
    ]);
    await store.saveMemoryDocument({
        sessionId: "cascade-sess-1",
        startSequence: 0,
        endSequence: 1,
        content: "turn content",
        embedding: [1, 0, 0, 0],
        embeddingProvider: "test",
        embeddingModel: "test",
    });

    const itemsBefore = await store.getTranscriptItems("cascade-sess-1");
    assert.equal(itemsBefore.length, 2);
    const docsBefore = await store.getMemoryDocuments("cascade-sess-1");
    assert.equal(docsBefore.length, 1);

    // Cascade delete: delete session
    // @ts-expect-error accessing private db for test assertion
    const db = store.getDb();
    db.prepare("DELETE FROM sessions WHERE id = ?").run("cascade-sess-1");

    // Cascaded rows must be automatically deleted
    const itemsAfter = await store.getTranscriptItems("cascade-sess-1");
    assert.equal(itemsAfter.length, 0);
    const docsAfter = await store.getMemoryDocuments("cascade-sess-1");
    assert.equal(docsAfter.length, 0);

    // Foreign key constraint violation on insert with nonexistent session
    assert.throws(() => {
        db.prepare(
            `INSERT INTO transcript_items (id, session_id, sequence, type, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("bad-item", "nonexistent-sess", 0, "user", "{}", new Date().toISOString());
    }, /FOREIGN KEY constraint failed/);

    await store.close();
});

test("Concurrent startup does not apply the same migration twice", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-concurrency-"));
    const dbPath = join(tmpDir, "concurrent.db");

    try {
        // Spawn 5 stores simultaneously pointing to the same file database
        const stores = Array.from({ length: 5 }, () => new SqliteConversationStore({ dbPath }));

        // Run all 5 initialize calls concurrently
        await Promise.all(stores.map((s) => s.initialize()));

        for (const s of stores) {
            assert.equal(await s.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
        }

        // Verify schema_migrations has exactly CURRENT_SCHEMA_VERSION rows
        // @ts-expect-error accessing private db for test assertion
        const db = stores[0].getDb();
        const count = db.prepare("SELECT COUNT(*) as cnt FROM schema_migrations").get() as {
            cnt: number;
        };
        assert.equal(count.cnt, CURRENT_SCHEMA_VERSION);

        for (const s of stores) {
            await s.close();
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("Validation: detects sequence gaps, duplicate versions, and invalid filenames", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-migration-validation-"));
    const dbPath = join(tmpDir, "val.db");

    try {
        const { mkdir } = await import("node:fs/promises");

        // 1. Invalid filename
        const badNameDir = join(tmpDir, "bad-name");
        await mkdir(badNameDir);
        await writeFile(join(badNameDir, "not_valid_name.sql"), "SELECT 1;");
        await assert.rejects(
            async () => {
                const store = new SqliteConversationStore({ dbPath, migrationsDir: badNameDir });
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("Invalid migration filename"));
                return true;
            },
        );

        // 2. Duplicate versions
        const dupDir = join(tmpDir, "duplicates");
        await mkdir(dupDir);
        await writeFile(join(dupDir, "0001_first.sql"), "SELECT 1;");
        await writeFile(join(dupDir, "0001_second.sql"), "SELECT 2;");
        await assert.rejects(
            async () => {
                const store = new SqliteConversationStore({ dbPath, migrationsDir: dupDir });
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("Duplicate migration version 1"));
                return true;
            },
        );

        // 3. Gap in sequence
        const gapDir = join(tmpDir, "gap");
        await mkdir(gapDir);
        await writeFile(join(gapDir, "0001_initial.sql"), "SELECT 1;");
        await writeFile(join(gapDir, "0003_three.sql"), "SELECT 3;");
        await assert.rejects(
            async () => {
                const store = new SqliteConversationStore({ dbPath, migrationsDir: gapDir });
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("gap detected"));
                return true;
            },
        );

        // 4. Sequence does not start at 1
        const nonOneDir = join(tmpDir, "non-one");
        await mkdir(nonOneDir);
        await writeFile(join(nonOneDir, "0002_two.sql"), "SELECT 2;");
        await assert.rejects(
            async () => {
                const store = new SqliteConversationStore({ dbPath, migrationsDir: nonOneDir });
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("must start at version 1"));
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("No event-loop-blocking retry loop during busy retry", async () => {
    let ticks = 0;
    const interval = setInterval(() => {
        ticks++;
    }, 5);

    let attempts = 0;
    const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

    try {
        const result = await executeWithRetry(
            () => {
                attempts++;
                if (attempts < 3) {
                    throw busyError;
                }
                return "ok";
            },
            5,
            20,
        );

        assert.equal(result, "ok");
        assert.equal(attempts, 3);
        // The event loop must have been able to process timers during asynchronous backoff
        assert.ok(
            ticks >= 2,
            `Expected event loop to tick during retry backoff, got ${ticks} ticks`,
        );
    } finally {
        clearInterval(interval);
    }
});

test("F-010: Migration runner rejects empty migration directories", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-mig-empty-"));
    try {
        const store = new SqliteConversationStore({
            dbPath: ":memory:",
            migrationsDir: tmpDir,
        });

        await assert.rejects(
            async () => {
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("Migration directory is empty"));
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("F-010: Migration runner rejects migrations without 0001_initial.sql", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-mig-no-initial-"));
    try {
        await writeFile(join(tmpDir, "0001_custom.sql"), "CREATE TABLE custom (id TEXT);", "utf8");
        const store = new SqliteConversationStore({
            dbPath: ":memory:",
            migrationsDir: tmpDir,
        });

        await assert.rejects(
            async () => {
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("0001_initial.sql"));
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("F-010: Migration runner detects and rejects unmanaged conflicting tables", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-unmanaged-"));
    const dbPath = join(tmpDir, "unmanaged.db");
    try {
        const db = new DatabaseSync(dbPath);
        // Create an unmanaged sessions table without schema_migrations
        db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, extra TEXT);");
        db.close();

        const store = new SqliteConversationStore({ dbPath });
        await assert.rejects(
            async () => {
                await store.initialize();
            },
            (err: unknown) => {
                assert.ok(err instanceof MigrationError);
                assert.ok(err.message.includes("unmanaged conflicting tables"));
                return true;
            },
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("F-022: Real process-level lock contention resolves successfully without deadlock", async () => {
    const { spawn } = await import("node:child_process");
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-contention-"));
    const dbPath = join(tmpDir, "contention.db");

    try {
        // First initialize schema so tables exist
        const store = new SqliteConversationStore({ dbPath });
        await store.initialize();
        await store.close();

        // Spawn child process that acquires a write lock (BEGIN IMMEDIATE) and holds it for 200ms
        const childCode = `
            import { DatabaseSync } from "node:sqlite";
            const db = new DatabaseSync(process.argv[1]);
            db.exec("BEGIN IMMEDIATE;");
            process.stdout.write("LOCKED\\n");
            setTimeout(() => {
                db.exec("COMMIT;");
                db.close();
                process.exit(0);
            }, 200);
        `;

        const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dbPath], {
            stdio: ["ignore", "pipe", "inherit"],
        });

        // Wait until child has acquired lock
        await new Promise<void>((resolve) => {
            child.stdout?.once("data", () => resolve());
        });

        // Now main process tries to execute a write operation under retry
        const competingStore = new SqliteConversationStore({ dbPath });
        await competingStore.initialize();
        await competingStore.saveSession({ id: "concurrent-session" });

        const session = await competingStore.getSession("concurrent-session");
        assert.ok(session);
        assert.equal(session.id, "concurrent-session");

        await competingStore.close();
        await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});
