import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 1;

export class MigrationError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "MigrationError";
        if (cause) {
            this.cause = cause;
        }
    }
}

export interface MigrationFile {
    readonly version: number;
    readonly name: string;
    readonly filename: string;
    readonly filepath: string;
    readonly sql: string;
    readonly checksum: string;
}

export interface MigrationOptions {
    readonly migrationsDir?: string;
}

export interface MigrationResult {
    readonly currentVersion: number;
    readonly appliedVersions: readonly number[];
}

export const computeChecksum = (sql: string): string => {
    const normalized = sql.replace(/\r\n/g, "\n");
    return createHash("sha256").update(normalized, "utf8").digest("hex");
};

export const getDefaultMigrationsDir = (): string => {
    return fileURLToPath(new URL("../../migrations", import.meta.url));
};

export const loadMigrations = async (migrationsDir: string): Promise<MigrationFile[]> => {
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const sqlEntries = entries.filter((e) => e.isFile() && e.name.endsWith(".sql"));

    const migrationCandidates: {
        version: number;
        name: string;
        filename: string;
        filepath: string;
    }[] = [];
    const versionMap = new Map<number, string[]>();

    for (const entry of sqlEntries) {
        const match = entry.name.match(/^(\d+)_([a-zA-Z0-9_-]+)\.sql$/);
        if (!match) {
            throw new MigrationError(
                `Invalid migration filename "${entry.name}". Migration files must match the pattern <version>_<name>.sql (e.g. 0001_initial.sql).`,
            );
        }

        const version = parseInt(match[1], 10);
        if (version <= 0 || isNaN(version)) {
            throw new MigrationError(
                `Invalid migration version ${match[1]} in "${entry.name}". Migration version must be a positive integer.`,
            );
        }

        const list = versionMap.get(version) ?? [];
        list.push(entry.name);
        versionMap.set(version, list);

        migrationCandidates.push({
            version,
            name: match[2],
            filename: entry.name,
            filepath: join(migrationsDir, entry.name),
        });
    }

    // Check for duplicates
    for (const [ver, files] of versionMap.entries()) {
        if (files.length > 1) {
            throw new MigrationError(
                `Duplicate migration version ${ver} detected: found in files ${files.map((f) => `"${f}"`).join(", ")}.`,
            );
        }
    }

    // Sort ascending by version
    migrationCandidates.sort((a, b) => a.version - b.version);

    // Validate sequential ordering starting at 1
    if (migrationCandidates.length > 0) {
        if (migrationCandidates[0].version !== 1) {
            throw new MigrationError(
                `Migrations must start at version 1, but found version ${migrationCandidates[0].version} in "${migrationCandidates[0].filename}".`,
            );
        }

        for (let i = 1; i < migrationCandidates.length; i++) {
            const prev = migrationCandidates[i - 1];
            const curr = migrationCandidates[i];
            if (curr.version !== prev.version + 1) {
                throw new MigrationError(
                    `Migration version sequence gap detected: expected version ${prev.version + 1}, found version ${curr.version} in "${curr.filename}".`,
                );
            }
        }
    }

    // Load SQL content and calculate checksums asynchronously
    const migrations: MigrationFile[] = [];
    for (const item of migrationCandidates) {
        const sql = await readFile(item.filepath, "utf8");
        const checksum = computeChecksum(sql);
        migrations.push({
            version: item.version,
            name: item.name,
            filename: item.filename,
            filepath: item.filepath,
            sql,
            checksum,
        });
    }

    return migrations;
};

interface AppliedMigrationRow {
    version: number;
    filename: string;
    checksum: string;
    applied_at: string;
}

const ensureSchemaMigrationsTable = (db: DatabaseSync): void => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
    `);

    // Verify existing columns to detect unsupported legacy experimental databases
    const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as unknown as {
        name: string;
    }[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("filename") || !columnNames.has("checksum")) {
        throw new MigrationError(
            "Unsupported legacy database schema detected: schema_migrations table is missing required metadata columns. " +
                "Akkco no longer supports this experimental database format. " +
                "A manual development reset is required. Please stop all Akkco processes and remove or back up the database: " +
                "rm ~/.akkco/akkco.db ~/.akkco/akkco.db-wal ~/.akkco/akkco.db-shm (or your custom AKKCO_DB_PATH).",
        );
    }
};

const validateAppliedMigrations = (
    applied: readonly AppliedMigrationRow[],
    available: readonly MigrationFile[],
): void => {
    const maxKnownVersion = available.length > 0 ? available[available.length - 1].version : 0;
    const availableMap = new Map<number, MigrationFile>(available.map((m) => [m.version, m]));

    // Check for unsupported future database versions
    for (const app of applied) {
        if (app.version > maxKnownVersion) {
            throw new MigrationError(
                `Database schema version ${app.version} is newer than supported version ${maxKnownVersion}. Upgrade Akkco to run with this database.`,
            );
        }
    }

    // Check that each applied migration exists in available files and checksum matches
    for (const app of applied) {
        const file = availableMap.get(app.version);
        if (!file) {
            throw new MigrationError(
                `Applied migration version ${app.version} (${app.filename ?? "unknown"}) is missing from migration files.`,
            );
        }

        if (app.checksum !== file.checksum) {
            throw new MigrationError(
                `Migration checksum mismatch for version ${file.version} ("${file.filename}"). Database recorded checksum "${app.checksum}", but file has "${file.checksum}".`,
            );
        }
    }

    // Ensure no unapplied gaps prior to the highest applied migration
    const appliedSet = new Set(applied.map((a) => a.version));
    const maxAppliedVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;

    for (const file of available) {
        if (file.version < maxAppliedVersion && !appliedSet.has(file.version)) {
            throw new MigrationError(
                `Migration version ${file.version} ("${file.filename}") is unapplied, but a later migration (version ${maxAppliedVersion}) has already been applied.`,
            );
        }
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const isSqliteBusy = (error: unknown): boolean => {
    if (!error || typeof error !== "object") {
        return false;
    }
    if ("code" in error && error.code === "SQLITE_BUSY") {
        return true;
    }
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes("database is locked") || msg.includes("busy");
    }
    return false;
};

export const executeWithRetry = async <T>(
    fn: () => T,
    maxRetries = 10,
    backoffMs = 25,
): Promise<T> => {
    let attempt = 0;
    while (true) {
        try {
            return fn();
        } catch (error: unknown) {
            if (isSqliteBusy(error) && attempt < maxRetries) {
                attempt++;
                const sleepMs = backoffMs * attempt;
                await sleep(sleepMs);
                continue;
            }
            throw error;
        }
    }
};

export const migrateDatabase = async (
    db: DatabaseSync,
    options?: MigrationOptions,
): Promise<MigrationResult> => {
    const migrationsDir = options?.migrationsDir ?? getDefaultMigrationsDir();
    const availableMigrations = await loadMigrations(migrationsDir);

    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 10000;");

    // Initialize tracking table and validate existing migration state under write lock
    await executeWithRetry(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
            ensureSchemaMigrationsTable(db);

            const appliedRows = db
                .prepare(
                    `
                SELECT version, filename, checksum, applied_at
                FROM schema_migrations
                ORDER BY version ASC
            `,
                )
                .all() as unknown as AppliedMigrationRow[];

            validateAppliedMigrations(appliedRows, availableMigrations);

            db.exec("COMMIT");
        } catch (error) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Ignore rollback failure if transaction was not active
            }
            if (error instanceof MigrationError) {
                throw error;
            }
            if (isSqliteBusy(error)) {
                throw error;
            }
            throw new MigrationError(
                `Failed to initialize migration state: ${error instanceof Error ? error.message : String(error)}`,
                error,
            );
        }
    });

    const newlyAppliedVersions: number[] = [];

    // Apply each pending migration in its own transaction with write lock
    for (const migration of availableMigrations) {
        await executeWithRetry(() => {
            db.exec("BEGIN IMMEDIATE");
            try {
                const alreadyApplied = db
                    .prepare("SELECT version FROM schema_migrations WHERE version = ?")
                    .get(migration.version);

                if (!alreadyApplied) {
                    try {
                        db.exec(migration.sql);

                        const insertStmt = db.prepare(`
                            INSERT INTO schema_migrations (version, filename, checksum, applied_at)
                            VALUES (?, ?, ?, ?)
                        `);
                        insertStmt.run(
                            migration.version,
                            migration.filename,
                            migration.checksum,
                            new Date().toISOString(),
                        );
                        newlyAppliedVersions.push(migration.version);
                    } catch (stepError) {
                        throw new MigrationError(
                            `Failed to apply migration version ${migration.version} ("${migration.filename}"): ${stepError instanceof Error ? stepError.message : String(stepError)}`,
                            stepError,
                        );
                    }
                }

                db.exec("COMMIT");
            } catch (error) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // Ignore rollback failure if transaction was not active
                }
                if (error instanceof MigrationError) {
                    throw error;
                }
                if (isSqliteBusy(error)) {
                    throw error;
                }
                throw new MigrationError(
                    `Failed to apply migration version ${migration.version} ("${migration.filename}"): ${error instanceof Error ? error.message : String(error)}`,
                    error,
                );
            }
        });
    }

    const currentVersionRow = db
        .prepare("SELECT MAX(version) as version FROM schema_migrations")
        .get() as unknown as { version: number | null } | undefined;

    return {
        currentVersion: currentVersionRow?.version ?? 0,
        appliedVersions: newlyAppliedVersions,
    };
};
