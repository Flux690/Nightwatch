# Git Rules

- Commits follow Conventional Commits: `<type>[scope]: <description>` (https://www.conventionalcommits.org/en/v1.0.0/)
  - Types: feat, fix, chore, docs, style, refactor, test, perf, ci, build, revert
  - No em dashes (—) ever. Use a hyphen (-) or comma instead.
  - Never reference issue/ticket numbers in the subject or body (no "issue 019",
    "Issue 019 -", "#12"). Describe the change itself; messages stand independent
    of the local `issues/` tracker.
- Commit body: when listing changes, use hyphen (`-`) bullets - one per line, a
  single space after the hyphen. Never use `*`, `•`, or dot bullets, and never
  leave the body as an unstructured wall of text. Keep it consistent across every
  commit.
- Never add `Co-Authored-By` footers. No AI attribution in commit messages.
- Commit after every completed task, and never batch multiple distinct tasks into
  one commit. Each commit must still be substantial - a coherent unit of related
  changes, not a 1-2 file micro-commit; fold trivial changes into the related
  body of work.
- Exception: when a single issue's `/tdd` implementation spans several vertical
  slices (e.g. backend change + shared type + several new frontend modules),
  "task" granularity is the issue as a whole, not each red-green-refactor slice.
  Keep working slice to slice without committing, then make one commit at the
  end covering the whole issue. Still run `pnpm typecheck && pnpm test` after
  every slice - only the commit cadence changes. Multiple distinct issues in one
  sitting still each warrant their own commit.
- Never amend published commits. Create a new commit instead.
- Never `git push` under any circumstances. Only the human pushes. No exceptions.
- Never `git push --force` to main. Blocked by hooks.
- Never `git commit --no-verify`. Hooks are there for a reason.
- Worktrees branch from the current feature branch (baseRef: head). Merge back when done.
- PRs: worktree branch → feature branch. Feature branch → main when complete and all tests pass.
