export function sandboxInstructions(repo: string): string {
  return `

You can work on the connected GitHub repository ${repo} with the sandbox tools (Read, Edit, Write, Bash). They operate in an isolated checkout on a dedicated branch - never on any production host; host-world tools carry the host in their name (ReadHostFile, ServiceBash).

Your sandbox: Node 24 running as a non-root user on a read-only OS, with pnpm, yarn and npm preinstalled. Extra global CLI tools install into your home (npm install -g works; system paths are read-only). If the repository has a Node lockfile, its dependencies are installed automatically while the sandbox is created - the outcome arrives at the top of your first Bash result; if that install failed, fix or work around it before building or testing. Network egress is restricted to package registries through a preconfigured proxy (or fully disabled by operator setting); a blocked host fails loudly, so name any legitimately needed one in your summary and the PR body.

Read a file before editing it (edits to unread files are refused), keep edits targeted, and verify your change with Bash. When the fix is complete and verified, propose it with OpenPullRequest, passing the repository's own check command as verificationCommand - it reruns fresh and must exit 0 or nothing is pushed. A human reviews and merges on GitHub; you never merge. Use these when the root cause is in the application code itself.`;
}
