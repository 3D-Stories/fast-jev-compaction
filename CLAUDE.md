## Deploy

This fork deploys to one machine. Since 2026-10-15 that machine runs it as a managed plugin,
`fast-jev-compaction@fast-jev-compaction-managed`: root-owned `/etc/claude-code/managed-settings.json` enables it, read in
place from a clone of `main` at `/home/rocky00717/rawgentic/projects/fast-jev-compaction-managed/plugin` (#15). The old git
install (marketplace `fast-jev-compaction`) stays installed but disabled.

1. In the PR, bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (fork versions 0.3.x).
2. After the merge: `git -C /home/rocky00717/rawgentic/projects/fast-jev-compaction-managed/plugin pull --ff-only`, and set
   the same `version` in the wrapper's `/home/rocky00717/rawgentic/projects/fast-jev-compaction-managed/.claude-plugin/marketplace.json`.
3. Verify: the clone's `HEAD` is the merge sha and its `git status` is clean. There is no cache copy to compare.
4. Prove it live in a fresh probe session (a throwaway herdr tab): type a message while a 50 s command runs, then
   `/compact`. The typed message must survive. Add a probe for the change being deployed, and require a log line
   only the new build emits.
5. Running sessions load it with `/reload-plugins`.

Never change the marketplace URL in settings alone: the plugin then fails to load ("source doesn't match its
extraKnownMarketplaces entry"). Change it, then at once run `claude plugin marketplace add <same url>`. Never remove
or uninstall the plugin to switch sources: its sensitive `apiKey` option is stored with the install.
