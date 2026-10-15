# Reactive Resume: agent instructions

This file applies across the repository. Follow a closer `AGENTS.md` when one exists. Keep this guide focused on agent workflows; user-facing documentation lives in `README.md` and `docs/`. Format guidance: [agents.md](https://agents.md/).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## Agent skills

- Issues and specs: GitHub Issues for `reactive-resume/reactive-resume`. See `docs/agents/issue-tracker.md`.
- Domain docs: single-context. Root `GLOSSARY.md` and `docs/adr/`; read before exploring. See `docs/agents/domain.md`.
- Check `git status --short` before editing. Preserve unrelated changes, including existing edits in this file.
- Use scripts and configuration as the source of truth when documentation disagrees with them.

## Overview

Reactive Resume is a free, open-source resume builder for creating, importing, exporting, and sharing resumes, cover letters, and job applications. It is a TypeScript pnpm monorepo managed by Turborepo, with two apps: `apps/web` (React 19 SPA with TanStack Router, TanStack Query, Tailwind CSS, and Vite) and `apps/server` (Hono / Node.js). oRPC connects browser workflows to server business logic; Better Auth handles authentication; Drizzle accesses PostgreSQL. Forme renders PDFs in the browser and on the server.

The production Docker image runs a single Node.js process on port 3000; `apps/server` mounts the API/auth/MCP/static routes and serves the built web app. On Vercel, the `frontend` service serves static assets through its CDN and the `backend` service runs the same Hono application in a Node.js Function.

Internal packages are source-consumed through `package.json` export maps pointing at `src` files. Do not assume package-local `dist` output exists unless a package explicitly adds it.

## Setup

Prerequisites: **Node.js 24** (`.nvmrc`, root `engines`, and Dockerfile), **pnpm 12.11.2** (root `packageManager`; pnpm self-manages to this version), and **Docker with Docker Compose** for local infrastructure. The Dockerfile's `ARG PNPM_VERSION` chooses its base image, not the project's pnpm version. Start your Docker daemon before running Compose.

Shared dependency versions live in the default `catalog` in `pnpm-workspace.yaml`. Use `catalog:` in workspace manifests when that shared range applies; keep intentional exact pins and peer dependency ranges explicit.

Run commands from the workspace root unless stated otherwise:

```sh
pnpm install --frozen-lockfile
test -e .env.local || cp .env.example .env.local
docker compose -f compose.dev.yml up -d postgres redis seaweedfs seaweedfs_create_bucket
docker compose -f compose.dev.yml ps
```

Copy `.env.example` to `.env.local` if it does not exist, then set the values listed in "Environment and database" below.

## Development workflow

```sh
pnpm dev
pnpm dev:web
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

- `pnpm dev` runs Vite on `PORT` (default `3000`), Hono on `SERVER_PORT` (default `3001`), and the email template preview on `3002`. Vite proxies API requests to Hono. Vite supplies hot reload; `tsx watch` restarts the server.
- `pnpm dev:web` starts only Vite; API workflows still need a server. If ports are busy, change `PORT` and `SERVER_PORT` consistently in `.env.local`; keep the email preview's `3002` port free when running all dev tasks.
- Server startup applies migrations before initializing auth and serving traffic. `pnpm db:migrate` applies them without starting the app; `pnpm db:studio` opens the database UI.
- After adding user-facing strings, use Lingui macros and run `pnpm lingui:extract`. Catalogs live in `apps/web/locales/*.po`; `pnpm pdf:translations` regenerates PDF translations. Root build/check scripts run PDF translation generation automatically.
- `pnpm docs:gen` regenerates the OpenAPI spec and semantic CSS reference. Use it when changing those public surfaces.
- Career/workspace changes: update the mapped user guides and fictional screenshots in the same change. Use `docs/contributing/career-platform.mdx` → **Keep product guides current**; verify UI labels, opt-ins, context, timezone and voice fallback against current code.

## Ownership map

Where each concern lives, and where new code for it goes:

| Area                                                                                            | Owner                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web routes, loaders, user-facing workflows                                                      | `apps/web/src/routes`, `apps/web/src/features` (file-based; never hand-edit `routeTree.gen.ts`)                                                                  |
| Server HTTP routes/adapters, startup checks, static handlers, MCP transport, OpenAPI/well-known | `apps/server/src/{http,rpc,mcp,openapi,static,startup}`                                                                                                          |
| Authenticated API contracts + business logic                                                    | `packages/api/src/features/*` (oRPC routers, DTOs, rate limiting; aggregated at `@reactive-resume/api/routers` for `/api/rpc`)                                   |
| Auth                                                                                            | `packages/auth` (Better Auth config/helpers/types; `apps/server/src/http/auth.ts` delegates to `auth.handler`)                                                   |
| DB client + schema                                                                              | `packages/db` (Drizzle; migrations at repo root `migrations/`)                                                                                                   |
| Server env validation                                                                           | `packages/env` (auto-loads root `.env`)                                                                                                                          |
| Resume/page/template Zod schemas                                                                | `packages/schema`                                                                                                                                                |
| Pure resume-domain behavior (no DB/HTTP/DOM/renderer deps)                                      | `packages/resume` (JSON Patch helpers, social-network icons)                                                                                                     |
| Resume PDF rendering                                                                            | `packages/pdf` (React templates converted through `src/forme` to Forme documents, font resolution, browser/server adapters)                                      |
| PDF.js viewer/canvas UI                                                                         | `apps/web/src/features/resume` — never in `packages/pdf`                                                                                                         |
| DOCX export                                                                                     | `packages/docx`                                                                                                                                                  |
| MCP tools/prompts/resources/server-card                                                         | `packages/mcp`                                                                                                                                                   |
| Generic UI primitives + hooks                                                                   | `packages/ui` (Base UI/shadcn-style); workflow-specific UI stays in the owning web feature                                                                       |
| DeepSeek Harness integration                                                                    | `packages/dsh-plugin` (separately built/published plugin)                                                                                                        |
| Focused support surfaces                                                                        | `packages/fonts`, `packages/email`, `packages/import`, `packages/ai`, `packages/utils`, `packages/config` — prefer existing exports over cross-package shortcuts |
| Dev-only scripts                                                                                | `tooling/`, not `packages/`, so packages only hold runtime-bundled code                                                                                          |

Narrow cross-cutting helpers go in `packages/utils` only after checking no domain package is a better owner. Specifically: resume JSON Patch behavior belongs in `@reactive-resume/resume/patch` and DOCX builders in `@reactive-resume/docx` — not in `@reactive-resume/utils`.

## Web app conventions

- `apps/web/src/router.tsx` initializes router context with `queryClient`, `orpc`, `theme`, `locale`, `session`, and `flags`. Reuse route context instead of refetching these ad hoc.
- The web app is a client-rendered SPA. The web build prerenders marketing homepages per locale; there is no request-time React SSR. `apps/server/src/static/web.ts` serves HTML and injects OpenGraph, canonical, and JSON-LD metadata. When adding a public marketing route, update its server fallback/SEO handling as well as the TanStack route; Vite's dev fallback can otherwise hide production 404s.
- Builder shell: `apps/web/src/routes/builder/$resumeId`. Public resume route: `apps/web/src/routes/$username/$slug.tsx`.
- Browser-only preview code: `apps/web/src/features/resume/preview`. Public PDF viewer: `apps/web/src/features/resume/public`. Keep PDF.js/canvas code in these features, not in `packages/pdf`.
- oRPC client: `apps/web/src/libs/orpc/client.ts` calls `/api/rpc` with credentials included. `apps/web/src/libs/orpc/fetch.ts` stages large request bodies through Blob on Vercel.
- For React components with explicit props, use a named props type (e.g. `type FooProps = {...}` with `function Foo(props: FooProps)`) rather than inline object annotations, especially with more than one field or with generics.

## Package boundaries

`pnpm exec turbo boundaries` is the executable check. Rules:

- Workspace deps go through package names and export maps. Never import another workspace's `src` tree via repo paths, `@reactive-resume/*/src/*`, or TS path aliases.
- Workspace `turbo.json` files declare coarse tags: `app:web`, `app:server`, `runtime:server` (server-only packages: API/auth/db/env/email/MCP), `runtime:browser` (browser-only shared UI), `runtime:universal` (environment-neutral domain packages), plus `role:domain|infra|adapter|api|rendering|tooling` for intent.
- Runtime-specific code lives behind explicit export subpaths (`@reactive-resume/pdf/browser`, `@reactive-resume/pdf/server`, `@reactive-resume/env/server`). Keep root exports environment-neutral unless the package is intentionally server-only.
- Wildcard exports are allowed only for leaf libraries with an intentionally file-like surface — currently `@reactive-resume/ui/components/*`, `@reactive-resume/ui/hooks/*`, and schema resume/application model files. Prefer explicit exports for packages owning runtime behavior.
- Prefer `protectedProcedure` from `packages/api/src/context.ts` for authenticated procedures. Expose only intentional public surfaces through `packages/api/package.json`.
- Shared PDF section filtering: `packages/pdf/src/templates/shared/filtering.ts`. Template-specific visual exceptions stay in the owning template directory unless multiple templates need the behavior. `packages/pdf/src/hooks/use-register-fonts.ts` resolves font families, weights, and script fallback stacks; the Forme adapter owns conversion/rendering. PDF generation needs no Browserless or Chromium service.

Multi-place changes:

- **Resume data shape**: `packages/schema/src/resume/*` first, then API DTOs, importers, PDF rendering, and web forms consuming it.
- **New template**: `packages/schema/src/templates.ts`, `packages/pdf/src/templates/index.ts`, source under `packages/pdf/src/templates/<name>/`, and previews under `apps/web/public/templates/{jpg,pdf}`.
- **New DB column/table**: `packages/db/src/schema/*`, then `pnpm db:generate`.
- **New env var**: `packages/env/src/server.ts`, `.env.example`, **and** the `globalPassThroughEnv` array and applicable test-task `env` arrays in `turbo.json`. Add deployment aliases in `packages/env/src/deployment.ts` when needed. Turborepo strict env mode filters unlisted injected variables from task processes.

## Environment and database

- Host dev needs `APP_URL`, `DATABASE_URL`, and a non-empty `AUTH_SECRET` (generate with `openssl rand -hex 32`). `.env.example` uses container hostnames, so use `localhost` for host-run code. Full reference: `docs/self-hosting/environment-variables.mdx`.
- `drizzle-kit` reads `DATABASE_URL` from `process.env` and does not load `.env`; root migration scripts load `.env.local` through `dotenvx`.
- Storage: explicit `STORAGE_BACKEND=local|s3|blob` wins. Otherwise complete S3 credentials select S3, Vercel selects private Blob, and other deployments use local storage. For database-only dev, start just `postgres` and set `STORAGE_BACKEND=local`.
- `ENCRYPTION_SECRET` (at least 32 characters) is required for saved AI providers and the assistant. `REDIS_URL` is optional outside Vercel; it shares rate limits, cancellation, and resumable replies between processes.
- `DATABASE_MIGRATION_URL` gives a direct migration connection when `DATABASE_URL` is pooled. Review generated migration SQL before applying it, and never reset databases or delete volumes to fix setup errors.
- Startup verifies the migrated schema. `STRICT_SCHEMA_CHECK=true` makes detected drift fatal.

## Testing and checks

Prefer package-scoped checks for the files changed. Package names come from their `package.json`: the apps are `web` and `server`, most shared packages are `@reactive-resume/<name>`.

```sh
pnpm --filter web typecheck
pnpm --filter @reactive-resume/pdf test
pnpm --filter @reactive-resume/pdf test src/templates/shared/filtering.test.ts
pnpm --filter @reactive-resume/pdf exec vitest run src/templates/shared/filtering.test.ts -t "filterItems"
pnpm --filter @reactive-resume/pdf test:coverage
pnpm exec oxlint --deny-warnings apps/web/src/features/resume
pnpm exec oxfmt --check apps/web/src/features/resume
pnpm exec turbo boundaries
```

- Vitest tests live alongside source as `src/**/*.test.ts(x)` or `src/**/*.spec.ts(x)` (including integration tests). Paths under `pnpm --filter <package>` are package-relative. Pass paths directly after `test`: an extra `--` currently prevents Vitest from filtering the run. Shared settings live in `vitest.shared.mts` and setup in `vitest.setup.ts`; most packages use Node, while `packages/ui` uses `happy-dom`.
- Coverage uses V8 and writes package-local `coverage/` reports. No shared minimum coverage threshold is configured. `test:ci` writes JSON/JUnit results under package-local `reports/`.
- Root `pnpm test`, `pnpm test:coverage`, and `pnpm typecheck` run workspace checks through Turbo. CI checks boundaries and affected-package typechecks, then runs all unit suites with `pnpm exec turbo run test:ci --concurrency=1` to avoid CPU contention in PDF/rate-limit suites. Unit/browser and Vercel workflows persist `.turbo/cache`; cached coverage and test reports restore to package-local output directories.
- Real-database unit suites use `COVER_LETTER_TEST_DATABASE_URL` and `OAUTH_TEST_DATABASE_URL`; see `.github/workflows/e2e.yml` for isolated database setup. Never point test fixtures at production data.
- After changing shared contracts, exports, or imports, check affected consumers and run `pnpm exec turbo boundaries`.

### Browser tests

Playwright specs live in `tests/e2e/specs/*.spec.ts`, with fixtures in `tests/e2e/fixtures`. Configure a disposable PostgreSQL database and export test environment variables before building/running; these root scripts do not wrap `dotenvx`.

```sh
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
pnpm test:e2e tests/e2e/specs/auth.spec.ts
pnpm test:e2e:ui
```

- `playwright.config.ts` starts `node apps/server/dist/index.mjs` in production mode and waits for `/api/health`; locally it can reuse an existing server. Build first. Keep the direct Node command: pnpm's script process groups can prevent Playwright from cleaning up a server started through `pnpm start`.
- Export `APP_URL`, `PORT`, `DATABASE_URL`, `AUTH_SECRET`, and `ENCRYPTION_SECRET`, and choose an absolute writable `LOCAL_STORAGE_PATH`. Auth fixtures need signups/email auth enabled; `FLAG_DISABLE_API_RATE_LIMIT=true` is appropriate for this isolated test installation.
- Assistant specs use a deterministic local AI stub and need `FLAG_ALLOW_UNSAFE_AI_BASE_URL=true`; otherwise those specs skip. See `tests/e2e/README.md` for the full environment recipe; adapt its example storage path to your machine.
- Playwright runs Chromium with no retries. CI uses one worker and retains failure traces, screenshots, videos, and reports. PDF/DOCX rasterization and visual regression are outside this browser gate.

## Code style

- Do not add code comments of any kind (`//`, `/* */`, `#`, or `<!-- -->` inside code). Express intent through names, types, and tests.
- TypeScript is strict, including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and unused-symbol checks; packages typecheck with `tsgo --noEmit`.
- Oxlint checks code with its native React Compiler and accessibility rules. Oxfmt uses tabs, double quotes, 120-column lines, separated type import groups, and sorted Tailwind classes in `clsx`, `cva`, and `cn`. Use existing file naming and feature-local conventions.
- **`pnpm check` modifies files**: it regenerates PDF translations, applies safe Oxlint fixes, runs Oxfmt, then fails on remaining lint errors or warnings. Review the diff; use `pnpm lint` and `pnpm format:check` for non-mutating checks.
- Lefthook's pre-commit hook checks conflict markers, applies safe Oxlint fixes, runs Oxfmt, then checks staged files with warnings denied and stages the fixes. The commit-message hook enforces Conventional Commits (`fix:`, `feat:`, `docs:`, etc.).

## Linting and formatting for coding agents

- After code changes, run `pnpm exec oxlint --fix <changed paths>`, then `pnpm exec oxfmt <changed paths>`. Safe lint fixes run before formatting and import/Tailwind sorting. Keep side-effect import order intact.
- Before finishing, run `pnpm lint:agent` (`oxlint --deny-warnings --format=agent`) and `pnpm format:check`. Fix diagnostics and recheck; do not disable rules merely to make a check pass. Any necessary inline suppression must name its rule and explain why.
- Lint rules live in `.oxlintrc.json`; formatting and import groups live in `.oxfmtrc.json`. Generated route trees, build outputs, migrations, OpenAPI JSON, generated schema references, and byte-sensitive PDF CSS fixtures are excluded where appropriate.
- `@shadcn/lint` is registered as a JS plugin. Its design-system rules are opt-in: configure them in `.oxlintrc.json` after choosing the policy. It discovers the shared UI exports and Tailwind theme through `apps/web/components.json` and `packages/ui/components.json`. See [available rules](https://github.com/shadcn-ui/lint#rules). Keep UI-specific policies scoped to the web app and UI package.
- Async test doubles may return a Promise without awaiting; the test override permits this. Playwright fixture callbacks named `use` are not React hooks, so `rules-of-hooks` is disabled only in the fixture adapter. Path references in declaration shims remain supported. CSS is formatted by Oxfmt; Oxlint checks JavaScript/TypeScript rather than CSS declarations.
- Editor setup is checked in under `.vscode/`: install the recommended Oxc extension for lint fixes and formatting on save. This workflow follows the [Oxc coding-agent guide](https://oxc.rs/docs/guide/usage/coding-agents.html). Restart Codex sessions after changing these instructions.

## Build and deployment

```sh
pnpm build
NODE_ENV=production pnpm start
docker compose up -d --build
```

- Build outputs: `apps/web/dist` (SPA assets), `apps/web/dist-prerender` (localized marketing HTML), and `apps/server/dist` (`index.mjs` plus chunks). `pnpm start` needs `NODE_ENV=production`, uses `PORT`, and does not load `.env.local`. Health endpoint: `/api/health`.
- Ship a desktop release with `node apps/desktop/scripts/pack-portable.mjs`. The result is `apps/desktop/portable/Reactive Resume.exe`: one file containing Node, the Hono server, `apps/web/dist`, and the WebView2 Fixed Version runtime. The WebView2 cab stays in `apps/desktop/.cache` and is not committed. First launch extracts that runtime to `%LOCALAPPDATA%\Reactive Resume\runtime\<version>`; resumes stay in `%LOCALAPPDATA%\Reactive Resume\data`.
- Deployment details live in the docs: Docker in `docs/self-hosting/docker.mdx`, Vercel Services and rewrites in `docs/self-hosting/vercel.mdx`, CI artifact and smoke checks in `docs/contributing/deployment-checks.mdx`, and image publishing in `docs/agents/container-publishing.md` (read it before release work).

## Security and pull requests

- Keep credentials and personal resume data out of source, logs, test artifacts, issues, and PRs. Do not commit local environment files or substitute production secrets for test values.
- Authenticated procedures use `protectedProcedure`; enforce resource ownership in feature logic. Reuse shared auth resolution for API keys, bearer tokens, and cookies rather than adding a separate auth path.
- Keep unsafe OAuth redirect/AI URL flags disabled on public deployments. They relax redirect validation and SSRF protections for trusted self-hosted/test use.
- Keep PRs focused. Describe the problem, resulting behavior, and checks actually run; link the relevant GitHub issue. Conventional Commits are enforced for commit messages; no separate PR-title convention is configured.
- Write issues and PR titles/descriptions in Chinese where possible. Keep code identifiers, commands, file paths, and error messages in their original form.
- Before submitting, run applicable typechecks/tests and non-mutating lint checks; run the production build for runtime/bundling changes. Match CI's database/browser prerequisites when reproducing its checks. Report skipped checks and failures instead of claiming they passed.

## Gotchas

- Without SMTP config, emails are logged to the server console; in dev, verification links appear there.
- Database connection errors: check `docker compose -f compose.dev.yml ps`. Use `localhost` for host-run code and service names inside containers.
- Route-tree errors: run Vite dev or build to regenerate `apps/web/src/routeTree.gen.ts`; never hand-edit it.
- Serverless module-loading failures: see "When the loading check fails" in `docs/contributing/deployment-checks.mdx`.
- Most test scripts use `--passWithNoTests`; a successful run with zero tests does not verify the behavior you changed.
