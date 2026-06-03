# Git Rules

- All v2 work happens on the `v2` branch.
- Commits follow Conventional Commits: `<type>[scope]: <description>` (https://www.conventionalcommits.org/en/v1.0.0/)
  - Types: feat, fix, chore, docs, style, refactor, test, perf, ci, build, revert
- Never add `Co-Authored-By` footers. No AI attribution in commit messages.
- Commit after every completed task. Never batch multiple tasks into one commit.
- Never amend published commits. Create a new commit instead.
- Never `git push` under any circumstances. Only the human pushes. No exceptions.
- Never `git push --force` to main or v2. Blocked by hooks.
- Never `git commit --no-verify`. Hooks are there for a reason.
- Worktrees branch from `v2` (baseRef: head). Merge back when done.
- PRs: worktree branch → v2. v2 → main only when phase is complete and all tests pass.
