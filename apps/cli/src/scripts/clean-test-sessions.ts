import { cleanupTestSessions, scanForTestSessions } from "@akkco/retrieval";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

/**
 * Maintenance script to scan, report, and safely clean up automated test sessions
 * from a persistent Akkco SQLite database.
 *
 * Enforces explicit review of exact session IDs before destructive cleanup and validates
 * backup integrity and record freshness before deleting any records.
 */
export const runCleanTestSessionsScript = async (argv: string[] = process.argv.slice(2)) => {
    let dbPath = process.env.AKKCO_DB_PATH ?? path.join(os.homedir(), ".akkco", "akkco.db");
    let isApply = false;
    let isConfirmed = false;
    const explicitSessionIds: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--db" && argv[i + 1]) {
            dbPath = argv[++i];
        } else if (arg === "--apply") {
            isApply = true;
        } else if (arg === "--dry-run") {
            isApply = false;
        } else if (arg === "--session" && argv[i + 1]) {
            explicitSessionIds.push(argv[++i]);
        } else if (arg === "--sessions" && argv[i + 1]) {
            explicitSessionIds.push(
                ...argv[++i]
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
        } else if (arg === "--confirm" || arg === "--yes" || arg === "-y") {
            isConfirmed = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log(`
Akkco Code — Test Session Cleaner

Usage:
  npx tsx apps/cli/src/scripts/clean-test-sessions.ts [options]

Options:
  --dry-run                Scan and report test sessions without modifying anything (default)
  --apply                  Create SQLite-consistent snapshot backup and clean test sessions
  --session <id>           Target specific reviewed session ID for cleanup (can be repeated)
  --sessions <id1,id2>     Target comma-separated list of reviewed session IDs for cleanup
  --confirm, -y            Skip interactive prompt when using --apply
  --db <path>              Custom SQLite database path (default: ~/.akkco/akkco.db)
  --help, -h               Show this help message
`);
            return 0;
        }
    }

    if (!existsSync(dbPath)) {
        console.error(`Database not found at "${dbPath}". Nothing to clean.`);
        return 1;
    }

    console.log(`Scanning database: ${dbPath}\n`);
    const report = await scanForTestSessions(dbPath);

    console.log(`Total sessions in database: ${report.totalSessions}`);
    console.log(`Identified test sessions:   ${report.testSessions.length}`);
    console.log(`Legitimate user sessions:   ${report.userSessionsCount} (will be preserved)\n`);

    if (report.testSessions.length === 0) {
        console.log("No test sessions detected. Database is completely clean!");
        return 0;
    }

    console.log("Identified Test Sessions:");
    console.log("-".repeat(80));
    for (const s of report.testSessions) {
        const date = s.createdAt.slice(0, 19).replace("T", " ");
        const preview = s.samplePrompt ? ` · "${s.samplePrompt.slice(0, 40)}"` : "";
        const status = s.deletionAuthorized ? "[authorized]" : "[review-required]";
        console.log(`  ${s.id}  (${date})  ${status}  [${s.reason}]${preview}`);
    }
    console.log("-".repeat(80));

    if (!isApply) {
        console.log("\n[DRY RUN] No records were modified or deleted.");
        console.log(
            "To create an automatic backup and permanently remove these test sessions, run:",
        );
        console.log(`  npx tsx apps/cli/src/scripts/clean-test-sessions.ts --apply\n`);
        return 0;
    }

    // Determine target session IDs to delete
    let sessionIdsToDelete: string[] = [];

    if (explicitSessionIds.length > 0) {
        // User explicitly specified exact session IDs
        sessionIdsToDelete = explicitSessionIds;
        console.log(`\nTargeting ${sessionIdsToDelete.length} explicitly specified session ID(s).`);
    } else {
        // No explicit session IDs specified
        const authorizedSessions = report.testSessions.filter(
            (s) => s.deletionAuthorized !== false,
        );
        sessionIdsToDelete = authorizedSessions.map((s) => s.id);

        if (!isConfirmed) {
            if (!process.stdin.isTTY) {
                console.error(
                    "\nError: Confirmation required. Pass explicit --session <id> or --confirm to apply changes non-interactively.",
                );
                return 1;
            }

            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
                console.log("\nExact Session IDs pending deletion:");
                for (const id of sessionIdsToDelete) {
                    console.log(`  - ${id}`);
                }
                const answer = await rl.question(
                    `\nAre you sure you want to create a SQLite snapshot backup and permanently delete these ${sessionIdsToDelete.length} reviewed test sessions? (yes/no): `,
                );
                if (answer.trim().toLowerCase() !== "yes" && answer.trim().toLowerCase() !== "y") {
                    console.log("Operation cancelled by user. No records were modified.");
                    return 0;
                }
            } finally {
                rl.close();
            }
        }
    }

    if (sessionIdsToDelete.length === 0) {
        console.log("No authorized test sessions selected for deletion. Exiting.");
        return 0;
    }

    console.log("\nCreating SQLite-consistent database snapshot and cleaning records...");
    const result = await cleanupTestSessions(dbPath, sessionIdsToDelete);

    console.log(`✔ SQLite snapshot backup created and verified at: ${result.backupPath}`);
    console.log(`✔ Deleted ${result.deletedSessions} test sessions.`);
    if (result.skippedSessions && result.skippedSessions.length > 0) {
        console.log(
            `ℹ Skipped ${result.skippedSessions.length} session(s) that did not satisfy revalidation criteria.`,
        );
    }
    console.log(
        `✔ Removed ${result.deletedTranscripts} transcript items, ${result.deletedMemories} memory documents, ${result.deletedSummaries} context summaries.`,
    );
    console.log(`✔ Preserved legitimate user sessions intact.\n`);

    return 0;
};

// Run if directly executed
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
    void runCleanTestSessionsScript().then((code) => {
        if (code !== 0) {
            process.exitCode = code;
        }
    });
}
