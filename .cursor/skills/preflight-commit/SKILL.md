---
name: preflight-commit
description: >-
  Run Parascene Desktop pre-commit quality gates, patch-bump the app version,
  and create a local git commit for review in GitHub Desktop. Use when the user
  is ready to commit, asks to wrap up changes, run preflight, bump version, or
  prepare a commit — including phrases like "preflight", "before I commit",
  "ready to commit", "wrap up", or "preflight commit". Creates the commit
  locally only. NEVER push, even if the user asks during preflight — pushing
  is always the user's job (e.g. GitHub Desktop).
---

# Preflight commit (Parascene Desktop)

Checklist before wrapping up work. Ends by **creating a local commit** so the
message is visible in GitHub Desktop History for review.

**Never push.** Do not run `git push`, `gh` publish, or any remote upload as
part of this skill — even if asked mid-preflight. The user pushes themselves.

## Steps (in order)

```
Preflight:
- [ ] 1. Typecheck
- [ ] 2. Lint (errors and warnings — prefer fix over disable)
- [ ] 3. Tests
- [ ] 4. Patch-bump version
- [ ] 5. Create local commit (GitHub Desktop review)
```

### 1. Typecheck

```bash
npm run typecheck
```

Fix failures before continuing.

### 2. Lint

```bash
npm run lint
```

Treat **errors and warnings** as blockers. Do not continue until both are
cleared for the changed code (and any new warnings introduced by this work).

**Prefer fixing the underlying issue** over silencing the linter. Do **not**
add `eslint-disable`, `eslint-disable-next-line`, `@ts-ignore`,
`@ts-expect-error`, or similar bypass comments by default.

If a rule truly cannot be satisfied without a disable/bypass comment:

1. **Stop and ask the user** what should be done (fix properly, accept a
   scoped disable with justification, or leave as-is).
2. Do **not** add the bypass comment until the user chooses that path.
3. If they approve a disable, keep it as narrow as possible (single line /
   single rule) and include a short why comment only when they ask for one.

Fix failures and warnings before continuing.

### 3. Tests

```bash
npm run test
```

If any `src-tauri/**` files changed in this work, also run:

```bash
cd src-tauri && cargo test --lib
```

Fix failures before continuing.

### 4. Patch-bump version

Read the current version from `package.json`. Bump the **patch** segment (`1.1.8` → `1.1.9`).

Write the **same** new version into all of:

| File | Field |
|------|--------|
| `package.json` | `"version"` |
| `package-lock.json` | root package `"version"` (use `npm version <new> --no-git-tag-version`, then sync Rust/Tauri files) |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/Cargo.lock` | `name = "parascene-desktop"` entry `version` |

Do **not** create a git tag. Do **not** bump major/minor unless the user asks.

### 5. Create local commit

Do **not** only suggest a message in chat — **create the commit** so GitHub Desktop shows it.

Follow the repo git safety rules:

1. `git status` / `git diff` / `git log -5 --oneline` (parallel) to see what will be committed and match message style.
2. Stage the relevant files for this wrap-up (include version bump files; exclude secrets).
3. Commit with a HEREDOC message in this repo’s style:

```text
<new-version> - <short why-focused summary>
```

Examples:

```text
1.1.8 - CRT Looks on Publisher render + async media protocol
1.1.7 - render media sync + focused UI op diagnostics
```

```bash
git commit -m "$(cat <<'EOF'
1.1.9 - short why-focused summary here.

EOF
)"
```

4. `git status` after commit to confirm success.
5. **Stop.** Do not push.

If a commit already exists from this preflight and only the message should change (and it was created by you in this conversation, not pushed), amend the message per the usual amend rules — otherwise make a new commit.

## Done response

Briefly confirm:

1. New version
2. Checks passed
3. Local commit created (hash + subject) — review/amend/push in GitHub Desktop yourself
