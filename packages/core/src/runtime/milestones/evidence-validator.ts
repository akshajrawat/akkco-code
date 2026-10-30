/**
 * Evidence validator for tool milestones.
 * Validates reported source locations, line numbers, and findings against actual tool outputs
 * to prevent hallucinated line numbers or fabricated source citations.
 */

export interface SourceLocationValidationResult {
    readonly verified: boolean;
    readonly normalized?: string;
    readonly rejectionReason?: string;
}

export interface ValidatedEvidence {
    readonly verifiedLocations: readonly string[];
    readonly unverifiedNotes: readonly string[];
    readonly establishedFindings: readonly string[];
    readonly uncertainFindings: readonly string[];
}

/**
 * Validates an individual source location string against the tool name, arguments, and raw output.
 */
export const validateSourceLocation = (
    location: string,
    toolName: string,
    toolArgs: unknown,
    rawResult?: string,
): SourceLocationValidationResult => {
    const trimmed = location.trim();
    if (!trimmed) {
        return { verified: false, rejectionReason: "Empty source location" };
    }

    if (!rawResult) {
        return {
            verified: false,
            rejectionReason: "No raw tool result available to verify location",
        };
    }

    // Match path:line or path:start-end
    const match = trimmed.match(/^([^:]+):(\d+)(?:-(\d+))?$/);
    const claimedPath = match ? match[1].trim() : trimmed;
    const claimedLine = match ? parseInt(match[2], 10) : undefined;
    const claimedEndLine = match && match[3] ? parseInt(match[3], 10) : undefined;

    if (toolName === "list_files") {
        // list_files only outputs file/directory entries, never line numbers.
        if (claimedLine !== undefined) {
            return {
                verified: false,
                normalized: claimedPath,
                rejectionReason: `Fabricated line number (${claimedLine}) from list_files which contains no line numbers`,
            };
        }

        const lines = rawResult
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        const exists = lines.some(
            (l) =>
                l === claimedPath || l.endsWith("/" + claimedPath) || claimedPath.endsWith("/" + l),
        );
        if (exists) {
            return { verified: true, normalized: claimedPath };
        }
        return {
            verified: false,
            rejectionReason: `Path "${claimedPath}" not found in list_files output`,
        };
    }

    if (toolName === "search_text") {
        // search_text outputs "relPath:lineNum:lineContent"
        const searchLines = rawResult.split("\n");
        if (claimedLine !== undefined) {
            const prefix = `${claimedPath}:${claimedLine}:`;
            const hasExactMatch = searchLines.some(
                (l) => l.startsWith(prefix) || l.includes(prefix),
            );
            if (hasExactMatch) {
                return { verified: true, normalized: trimmed };
            }
            // Check if path exists but line does not
            const pathExists = searchLines.some(
                (l) => l.startsWith(`${claimedPath}:`) || l.includes(`${claimedPath}:`),
            );
            if (pathExists) {
                return {
                    verified: false,
                    normalized: claimedPath,
                    rejectionReason: `Line number ${claimedLine} not found in search results for ${claimedPath}`,
                };
            }
            return {
                verified: false,
                rejectionReason: `Path ${claimedPath} not found in search results`,
            };
        }

        // Just path
        const pathExists = searchLines.some(
            (l) => l.startsWith(`${claimedPath}:`) || l.includes(`${claimedPath}:`),
        );
        if (pathExists) {
            return { verified: true, normalized: claimedPath };
        }
        return {
            verified: false,
            rejectionReason: `Path ${claimedPath} not found in search results`,
        };
    }

    if (toolName === "read_file") {
        const argPath = (toolArgs as Record<string, unknown> | null)?.path;
        const targetPath = typeof argPath === "string" ? argPath : claimedPath;
        const pathMatches =
            claimedPath === targetPath ||
            targetPath.endsWith("/" + claimedPath) ||
            claimedPath.endsWith("/" + targetPath);

        if (!pathMatches && !rawResult.includes(claimedPath)) {
            return {
                verified: false,
                rejectionReason: `Path ${claimedPath} does not match read_file target ${targetPath}`,
            };
        }

        if (claimedLine !== undefined) {
            const fileLines = rawResult.split("\n");
            const totalLines = fileLines.length;

            if (claimedLine < 1 || claimedLine > totalLines) {
                return {
                    verified: false,
                    normalized: claimedPath,
                    rejectionReason: `Fabricated line number ${claimedLine} out of bounds (file has ${totalLines} lines)`,
                };
            }

            if (
                claimedEndLine !== undefined &&
                (claimedEndLine < claimedLine || claimedEndLine > totalLines)
            ) {
                return {
                    verified: false,
                    normalized: claimedPath,
                    rejectionReason: `Fabricated end line ${claimedEndLine} out of bounds (file has ${totalLines} lines)`,
                };
            }

            return { verified: true, normalized: trimmed };
        }

        return { verified: true, normalized: claimedPath };
    }

    // Generic tool validation
    if (rawResult.includes(trimmed)) {
        return { verified: true, normalized: trimmed };
    }
    if (claimedPath && rawResult.includes(claimedPath)) {
        if (claimedLine !== undefined) {
            return {
                verified: false,
                normalized: claimedPath,
                rejectionReason: `Line number ${claimedLine} could not be verified in tool output`,
            };
        }
        return { verified: true, normalized: claimedPath };
    }

    return {
        verified: false,
        rejectionReason: `Location "${trimmed}" does not appear in tool output`,
    };
};

/**
 * Validates a collection of source locations and separates established findings from uncertain interpretations.
 * Distinguishes direct observations grounded in raw evidence from interpretations and unverified claims.
 */
export const validateEvidence = (
    reportedLocations: readonly string[] | undefined,
    findings: readonly string[],
    toolName: string,
    toolArgs: unknown,
    rawResult?: string,
    interpretations: readonly string[] = [],
    unresolvedQuestions: readonly string[] = [],
): ValidatedEvidence => {
    const verifiedLocations: string[] = [];
    const unverifiedNotes: string[] = [];

    if (reportedLocations && reportedLocations.length > 0) {
        for (const loc of reportedLocations) {
            const result = validateSourceLocation(loc, toolName, toolArgs, rawResult);
            if (result.verified) {
                const finalLoc = result.normalized ?? loc;
                if (!verifiedLocations.includes(finalLoc)) {
                    verifiedLocations.push(finalLoc);
                }
            } else if (result.rejectionReason) {
                unverifiedNotes.push(`Rejected location "${loc}": ${result.rejectionReason}`);
                if (result.normalized && !verifiedLocations.includes(result.normalized)) {
                    const pathRes = validateSourceLocation(
                        result.normalized,
                        toolName,
                        toolArgs,
                        rawResult,
                    );
                    if (pathRes.verified) {
                        verifiedLocations.push(result.normalized);
                    }
                }
            }
        }
    }

    const establishedFindings: string[] = [];
    const uncertainFindings: string[] = [];

    // All explicit interpretations from summarizer go into uncertain findings (Needs Recheck)
    for (const interp of interpretations) {
        const trimmed = interp.trim();
        if (trimmed && !uncertainFindings.includes(trimmed)) {
            uncertainFindings.push(trimmed);
        }
    }

    // All explicit unresolved questions go into uncertain findings (Needs Recheck)
    for (const q of unresolvedQuestions) {
        const trimmed = q.trim();
        if (trimmed && !uncertainFindings.includes(trimmed)) {
            uncertainFindings.push(trimmed);
        }
    }

    // Inferential pattern: statements that represent inferences or speculative conclusions
    const inferentialPattern =
        /\b(assumes|suggests|implies|probably|likely|seems|intended to|might|could be|unclear|unverified|possibly|perhaps|suspected|presumed|hypothesized)\b/i;

    const totalLines = rawResult ? rawResult.split("\n").length : 0;

    for (const finding of findings) {
        const trimmed = finding.trim();
        if (!trimmed) continue;

        // 1. Check for inferential/interpretive language
        if (inferentialPattern.test(trimmed)) {
            uncertainFindings.push(trimmed);
            continue;
        }

        // 2. Validate cited line numbers if present in finding (e.g. @192-200 or @42)
        const citeMatch = trimmed.match(/@(\d+)(?:-(\d+))?/);
        if (citeMatch && toolName === "read_file") {
            const startLine = parseInt(citeMatch[1], 10);
            const endLine = citeMatch[2] ? parseInt(citeMatch[2], 10) : startLine;

            if (startLine < 1 || endLine > totalLines || startLine > endLine) {
                // Fabricated line citation! Move to uncertain findings
                uncertainFindings.push(
                    `Claim with invalid line range @${startLine}${citeMatch[2] ? `-${endLine}` : ""} (file has ${totalLines} lines): ${trimmed.replace(/@\d+(?:-\d+)?/, "").trim()}`,
                );
                continue;
            }
        } else if (citeMatch && toolName === "list_files") {
            // list_files output has no line numbers: citation is fabricated
            uncertainFindings.push(
                `Claim with fabricated line citation from list_files: ${trimmed}`,
            );
            continue;
        }

        // 3. Grounding check on specific code identifiers in backticks
        const backtickMatches = trimmed.match(/`([^`]+)`/g);
        if (backtickMatches && rawResult) {
            let ungrounded = false;
            for (const m of backtickMatches) {
                const identifier = m.slice(1, -1).trim();
                // If identifier looks like a symbol (>3 chars) and does not exist in raw result
                if (identifier.length > 3 && !rawResult.includes(identifier)) {
                    ungrounded = true;
                    break;
                }
            }
            if (ungrounded) {
                uncertainFindings.push(
                    `Claim mentions ungrounded symbol not found in tool output: ${trimmed}`,
                );
                continue;
            }
        }

        // Observation is directly supported by evidence
        establishedFindings.push(trimmed);
    }

    // Append source location rejection notes into uncertain findings so they appear in Needs Recheck
    for (const note of unverifiedNotes) {
        if (!uncertainFindings.includes(note)) {
            uncertainFindings.push(note);
        }
    }

    return {
        verifiedLocations,
        unverifiedNotes,
        establishedFindings,
        uncertainFindings,
    };
};
