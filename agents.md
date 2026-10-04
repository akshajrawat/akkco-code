## Rules for Writing Code

- Only add explicit types when TypeScript cannot infer them clearly from the function or surrounding code.
- Only use arrow functions, except where the language requires another form.
- Always use async versions of file operations.
- After every meaningful repo change, update `ARCHITECTURE.md` so it reflects the current methodology, package structure, and architecture.
- Run the necessary tests, type checks, linters, and other relevant verification after making changes. Only run tests when you actually change something
- Dont keep again and again making a function if such function already exist anywhere from where it can be used
- Only import the thing you want to use
- Match the existing codebase’s spacing, indentation, line breaks, and surrounding formatting style; do not introduce a new formatting pattern when nearby code already establishes one.
- Read `ARCHITECTURE.md` to get an idea of what we are building before any change
- Always use `npm` as the package manager for running scripts and managing dependencies (do not use pnpm, yarn, or bun).
- For changes affecting interactive TUI behavior, run the PTY E2E suite (`npm run test:tui`) in addition to normal unit/type/format verification.

### Public API Hygiene

- Keep package public exports minimal and intentional.
- Do not export internal helpers, utilities, canonicalizers, serializers, counters, or implementation details from a package `index.ts` unless another package or external consumer genuinely needs them.
- Prefer exposing stable contracts and domain-level types such as errors, option types, and interfaces rather than internal mechanics.
- Tests may import internal modules directly when testing implementation-specific behavior; do not widen the production public API only to make tests convenient.
- Before adding a new export, ask: "Is this part of the package contract, or only an implementation detail?"
- Removing unnecessary exports is preferred while the project is still pre-stable, before consumers begin depending on them.

## Repository Structure

- Prefer conceptual grouping over large flat directories.
- Keep a directory flat while it only contains a small number of closely related files.
- Create subfolders when a real responsibility or domain has multiple files or is clearly growing.
- Do not create folders only for symmetry.
- Do not create `index.ts` files inside every folder unless that folder genuinely needs a public/module boundary.
- Keep package public APIs stable. Internal refactors should not force consumers to import from internal paths unless a deliberate subpath API is designed.
- Tests should generally mirror the conceptual structure of the production code.
- Before adding several new files to an existing directory, check whether that directory should first be reorganized by responsibility.

## Architecture Decisions

- Design hard-to-change boundaries with future growth in mind.
- Keep easy-to-change internals minimal until they are actually needed.
- Do not add abstractions only because they may be useful someday.
- Prefer stable interfaces with replaceable implementations.
- Do not redesign existing architecture unless there is a concrete problem or the task explicitly requires it.

## Change Discipline

- Do not modify unrelated files.
- Do not silently broaden the scope of a task.
- Preserve existing behavior unless the requested change explicitly changes it.
- If a change requires modifying an architectural contract, explain why before changing it.
