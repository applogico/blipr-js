# Git hooks

`main` requires **verified signatures**, so every commit must be SSH/GPG-signed.
These hooks stop an unsigned commit before it becomes a problem.

## Activate (one-time, per clone)

```bash
git config core.hooksPath .githooks
```

Worktrees share the repo config, so this covers them too.

## What they do

- **`pre-commit`** — fails the commit if `commit.gpgsign` isn't `true`, so signing
  can't be silently off. (git applies the signature *after* commit hooks run and
  `--no-gpg-sign` isn't visible to hooks, so this can only enforce config.)
- **`pre-push`** — the real guard: rejects the push if any commit being pushed
  has **no signature** (no `gpgsig` header). Catches `--no-gpg-sign` commits and
  anything unsigned before it leaves your machine.

## If a push is blocked

Sign the offending commit(s) and push again:

```bash
git commit --amend -S --no-edit                                   # last commit
git rebase --exec 'git commit --amend -S --no-edit' <base>        # a range
```

Signing needs your key available (e.g. unlock 1Password if you sign via
`op-ssh-sign`).
