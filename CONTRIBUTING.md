# Contributing to Nanachi Remote

Nanachi Remote is a public repository maintained by [@j-carv](https://github.com/j-carv). Contributions are welcome, but a public repository is not permission to push, merge, or change repository settings. Public visibility is not an automatic license grant; follow any applicable license and GitHub terms. This guide does not add a license, CLA, DCO, or signature requirement.

## Maintainer review and merge policy

- External contributors work in a fork and open a pull request against `master`.
- Every file is owned by @j-carv through `.github/CODEOWNERS`. External pull requests need @j-carv's code-owner approval before merging.
- New commits dismiss stale approvals; request another review after updating an approved pull request.
- Only @j-carv, acting as the repository owner/administrator, may bypass protections for a direct push or an exceptional merge. Other contributors must use the pull-request process.
- Pull requests are squash-merged. The pull-request title becomes the squash commit subject, so keep it accurate as the change evolves. Automatic merging is disabled; the maintainer decides when to merge.

The active branch rules are recorded in [`.github/rulesets/master.json`](.github/rulesets/master.json). Only the owner can update `master`; even a future collaborator with write access cannot merge changes into it independently. GitHub is the enforcement point: editing that JSON file alone does not change the live rules.

Workflow tokens default to read-only and cannot approve pull requests. Workflows originating from external fork contributions require maintainer approval before running. The title-only `pull_request_target` workflow is separate: it uses trusted base-branch code, no token permissions, no checkout, and no contributor code.

Discuss substantial changes in an issue before implementing them. Keep each pull request focused on one change, avoid unrelated cleanup, and include the documentation and tests relevant to that change.

## Work from a fork

Install Git and Node.js **22 or newer** with npm. Windows 11 is the project's development environment. Run these commands from PowerShell, replacing `YOUR-USERNAME` with your GitHub username:

```powershell
git clone https://github.com/YOUR-USERNAME/nanachi-remote-control.git
cd nanachi-remote-control
git remote add upstream https://github.com/j-carv/nanachi-remote-control.git
git fetch upstream
git switch -c feat/describe-your-change upstream/master
npm ci
```

Choose a short branch name such as `fix/pairing-message` or `docs/android-setup`. Push your branch to your fork and open a pull request with base repository `j-carv/nanachi-remote-control` and base branch `master`.

For daemon and phone testing, follow the [README](README.md), including Tailscale and agent setup. Do not expose the daemon publicly just to test a contribution.

## Check your change locally

Run the repository's existing commands from its root in PowerShell:

```powershell
npm ci
npm run build
npm run typecheck
npm test
```

Run each command separately and record its outcome. Use relevant focused tests and manual checks as well; describe the environment and exact steps so the maintainer can reproduce them. For a documentation-only change, explain which instructions or links you reviewed and whether any commands were actually exercised.

If a check fails, report the command, failing test or error, and whether you observed the same failure before your change. Do not claim a pass, hide failures, or change unrelated tests just to get a green result. If you did not establish the cause, say so. Mark checks you could not run as **not run**, with the reason.

The GitHub workflow described below checks only the pull-request title. It does **not** build, typecheck, test, or certify the application.

## Commit messages and pull-request titles

Use this Conventional Commits format for the pull-request title:

```text
type(scope)!: description
```

- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- The scope is optional. If present, it is nonempty and enclosed in parentheses; nested parentheses and control characters are not allowed.
- `!` is optional and goes immediately before the colon to flag a breaking change. Explain breaking changes in the pull-request description.
- Use a colon followed by exactly one space, then a description whose first character is not whitespace.
- Use one line only, without carriage returns or line feeds.

Examples:

```text
docs: improve Android setup
fix(daemon): correct pairing expiry message
feat(pwa)!: change machine pairing flow
```

The **PR title** check runs when a pull request targeting `master` is opened, edited, updated with commits, reopened, or marked ready for review. It validates only the title, treating it as data; it does not check out or execute contributor code. Fix a rejected title by editing it on GitHub.

Conventional Commits are also recommended for local commits, but there is no local hook enforcing them. To use the optional commented commit-message guidance in this repository:

```powershell
git config --local commit.template .gitmessage
```

This template is an editing aid, not validation. Individual local commits do not need to become the final history: the accepted pull-request title is used for the squash commit subject.

## Evidence and sensitive data

Use synthetic examples and a disposable test workspace. Never commit or attach real credentials, tokens, pairing codes, personal data, private agent conversations, desktop captures, or real daemon data. This includes material in issue text, logs, screenshots, videos, fixtures, and pull-request descriptions.

Keep `%USERPROFILE%\.nanachi-remote` and its configuration, databases, device records, and session data out of contributions. Do not publish real tailnet names, account identifiers, private paths, or agent output. If visual evidence is necessary, capture only a dedicated test interface using synthetic data, not your real desktop, and inspect the entire image for sensitive information before sharing it. For logs, provide only the minimal sanitized excerpt needed to explain the issue.

A useful pull request explains what changed, why it is needed, how it was checked, and any remaining limitations. Do not paste secrets into a public report; removing them later does not undo their exposure.
