## Deploy

This fork deploys to the machine that installs the plugin from it (marketplace `fast-jev-compaction`, source
`https://github.com/3D-Stories/fast-jev-compaction.git`).

1. In the PR, bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (fork versions 0.3.x).
2. After the merge: `claude plugin marketplace update fast-jev-compaction`, then
   `claude plugin update fast-jev-compaction@fast-jev-compaction`.
3. Verify: `~/.claude/plugins/installed_plugins.json` shows the new version and the merge sha, and every file under
   `hooks src .claude-plugin types` in `~/.claude/plugins/cache/fast-jev-compaction/fast-jev-compaction/<version>/`
   equals `origin/main` (`git show origin/main:<f> | cmp - <cache>/<f>`).
4. Prove it live in a fresh probe session (a throwaway herdr tab): type a message while a 50 s command runs, then
   `/compact`. The typed message must survive. Add a probe for the change being deployed, and require a log line
   only the new build emits.
5. Running sessions load it with `/reload-plugins`.

Never change the marketplace URL in settings alone: the plugin then fails to load ("source doesn't match its
extraKnownMarketplaces entry"). Change it, then at once run `claude plugin marketplace add <same url>`. Never remove
or uninstall the plugin to switch sources: its sensitive `apiKey` option is stored with the install.
