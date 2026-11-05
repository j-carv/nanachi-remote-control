# Repository instructions

These instructions apply to the entire Nanachi Remote repository. Read [CONTRIBUTING.md](CONTRIBUTING.md) before preparing a change. Use [README.md](README.md) for setup and user-facing behavior.

## Language and communication

- Write new documentation, code comments, identifiers, commit messages, and pull-request titles/descriptions in English. Follow existing naming when editing code; do not rename unrelated symbols just to translate them.
- The application currently has Portuguese UI labels. Preserve the actual labels when documenting navigation, with an English explanation where useful. Translating documentation is not permission to localize the application.
- Keep prose direct, human, and specific. State what changed, why, how it was verified, and any limitations. Never claim a check passed unless you ran it and observed success.

## Ownership and scope

- The default branch is `master`. The repository is public, but contributions are reviewed and merged at the maintainer's discretion. Public visibility does not grant write access or add a software license.
- `@j-carv` owns every path through `.github/CODEOWNERS`. External changes go through a fork and pull request. Only the owner has the approved administrative bypass for exceptional merges or direct pushes.
- Do not change repository permissions, rulesets, workflow permissions, or code ownership unless explicitly requested by the maintainer. Files in the repository describe policy; the active GitHub settings enforce it.
- Inspect the working tree before editing. Preserve other people's uncommitted changes. Stage only the files belonging to the requested task; never use a blanket add when unrelated work is present.
- Do not commit, push, merge, publish a release, rewrite history, force-push, or delete branches without explicit authorization. Never disable protections just to make a check pass.
- Keep changes focused. Do not add dependencies, abstractions, compatibility layers, or unrelated cleanup without a concrete need in the requested change.

## Project conventions

- This is an npm-workspaces monorepo. Use npm and keep `package-lock.json` consistent with intentional dependency changes; do not introduce another package manager or lockfile.
- `packages/shared` owns shared protocol types and Zod schemas. Update producers, consumers, and relevant tests together when a contract changes; do not duplicate schemas in the daemon or PWA.
- `packages/daemon` owns Fastify routes, WebSocket handling, SQLite persistence, agent processes, and CLI commands. `packages/pwa` owns the React/Vite interface and service worker.
- Preserve the strict TypeScript options in `tsconfig.base.json`. Prefer existing types and explicit narrowing over `any`, unchecked assertions, or suppressed diagnostics.
- Reuse existing module, error-handling, component, styling, and test patterns. Read nearby code before introducing a new convention.
- Windows is the development environment. Handle spaces and non-ASCII characters in paths, quote shell arguments, and do not assume Unix utilities or WSL are available to users.
- Keep the daemon loopback-only. Do not weaken authentication, Host/Origin checks, Tailscale restrictions, or agent permissions to make development easier. `allowedRoots` is a workspace selector, not a sandbox.
- Preserve the user's app artwork in `packages/pwa/public`. Do not regenerate or replace icons unless requested.

## Structured commits and pull requests

Use Conventional Commits in English:

```text
type(scope)!: concise description
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scope and `!` are optional. Use a lowercase type, exactly one space after the colon, and a nonblank, single-line description. Explain breaking changes in the body.

```text
docs: clarify Android installation
fix(daemon): preserve session history after reconnect
feat(pwa)!: change the pairing flow
```

- Keep each commit and PR coherent. Describe behavior and intent rather than listing touched files.
- Use the PR template and include verification evidence. Do not hide failures or mark unperformed checks as complete.
- PRs are squash-merged, and the PR title becomes the final commit subject. The `PR title` workflow validates the title, not application correctness.
- `.gitmessage` is optional editing guidance, not a validation hook. Do not claim local commit messages are automatically enforced.
- Configure Git identity per repository when needed; never change global Git settings. Prefer a GitHub-provided `noreply` email for public commits instead of publishing a private address.

## Live supervisor

Some checkouts run a live supervisor that serves the maintainer's phone. Check for it before building anything:

- Run `npm run autostart -w @nanachi/daemon -- status`. If it reports the supervisor as running:
  - Do not run `npm run build`, `vite build` or `vite --watch`. They race the supervisor's watch build and cause `EBUSY` errors.
  - Do not run a `vite` dev or preview server against `packages/pwa` while the supervisor runs. Any process with a handle on the PWA output folders can block the watch build from publishing. Take screenshots through the e2e daemons on their own ports.
  - The watch build publishes each build to `packages/pwa/releases/<id>/` and points `releases/current.json` at it; the daemon serves that release. `packages/pwa/dist` is only the fallback when there is no pointer. Keep the last three releases; a release that cannot be deleted yet is retried by the next build.
  - To see whether the code compiles, read the tail of `%USERPROFILE%\.nanachi-remote\supervisor.log` instead of building.
  - Do not stop the supervisor, and do not use port 7777 for tests. Tests and E2E scripts start their own daemons on other ports. Do not run `e2e/run.mjs`.
  - PWA changes reach the phone the next time the app is opened.
  - Daemon changes reload the daemon after 60 seconds with no busy session. Idle sessions resume by themselves after the reload.
- If the supervisor is not running, the build step in Verification applies as written.

## Verification

Run commands from the repository root. For code changes, use the relevant focused checks and the existing scripts:

```powershell
npm ci
npm run typecheck
npm test
```

- `npm run build` applies only when the live supervisor is not running (see Live supervisor). It compiles `shared` first.
- Compile `shared` before exercising packages that depend on its built output. The root build does that; with the supervisor running, its watch build does.
- Keep regression tests deterministic, isolated, and focused on observable behavior. Do not replace real integrations with fake production behavior.
- Exercise the changed runtime path when practical, in addition to automated checks. Use temporary data rather than the maintainer's running daemon or real agent account unless specifically authorized.
- Follow the prerequisites in each `e2e/` script. The basic `npm run e2e` uses a real agent; do not run it casually or consume paid services without authorization.
- Documentation-only changes need link/anchor and instruction checks, not unrelated code changes. Workflow changes need an actual exercise of the validation logic, including rejected inputs and untrusted text.
- Report failures precisely. Existing failures are not permission to delete tests, weaken assertions, skip checks silently, or fix unrelated code.
- Browser emulation is not a physical-device test. Do not claim Android/iPhone installation, keyboard behavior, or push notifications were validated on a real device unless they were.

## Privacy and secrets

- Never commit tokens, API keys, private keys, passwords, real pairing codes, personal email addresses, private tailnet hostnames, or real agent conversations. Use synthetic fixture data and generic paths such as `C:\Projects`.
- Keep daemon data outside the repository: `%USERPROFILE%\.nanachi-remote`, or the configured `NANACHI_HOME`, contains private configuration, databases, push keys, files, and sessions.
- Do not publish desktop captures, raw logs, recordings, local handoff notes, or tool state. Check screenshots and attachments for private information before sharing.
- `.gitignore` does not remove files already tracked or erase history. Review the actual staged files and commit metadata before publishing.
- If a secret is exposed, stop publishing it, notify the maintainer without repeating the value, and recommend revocation/rotation. A later deletion does not undo exposure. History rewriting requires separate authorization.
