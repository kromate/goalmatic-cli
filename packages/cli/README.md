# goalmatic

Public Node.js CLI for creating and managing Goalmatic Sites and Apps.

Install the public beta with `npm install -g goalmatic@beta`, or run commands
with `npx goalmatic@beta`. Node.js 22.12 or newer is required.

Read the [Goalmatic developer docs](https://goalmatic.mintlify.site/quickstart).

```bash
goalmatic login
goalmatic create my-todo
cd my-todo
goalmatic git connect
goalmatic git status
goalmatic deploy --preview
goalmatic publish
```

`create` writes a Vue todo starter with its npm lockfile, creates the remote
project through an idempotent request, and stores local project identity in
`goalmatic.json`. If the request is interrupted, rerun the same command to
resume it. `link` downloads an existing project's current source only into an
empty directory.

After remote creation, the wizard recommends GitHub connection. It authorizes
the Goalmatic GitHub App, selects or creates the exact repository, migrates
source authority on the server, fetches the preview branch into the same
folder, and sets the index with a mixed reset. It does not replace working-tree
files, commit changes, or push. For unattended setup, pass `--yes --owner NAME
--repo NAME`; otherwise `--yes` skips GitHub and prints the follow-up command.

Use `goalmatic create my-todo --local` for a free local-only starter. It does
not sign in, create a Goalmatic project, connect GitHub, deploy, or publish.

Interactive login stores its credential under `~/.config/goalmatic` with
restricted permissions. Set `GOALMATIC_TOKEN` for CI. The CLI never accepts a
token flag or prints a token. The default API origin is
`https://goalmatic.site`; `--api-url` accepts HTTPS origins and loopback HTTP.

GitHub connection uses the Goalmatic GitHub App and the Site Builder source
sync endpoints. The server migrates source authority and creates the protected
production and editable preview branches. Deploy and publish commands require
a clean checkout whose branch and commit match Goalmatic's imported Git head.

For Sites, `deploy --preview` creates a preview deployment and `publish`
publishes the pinned revision. For Apps, `deploy --preview` creates a private
test build. `publish` submits an immutable App release for review and prints
the returned status; submission does not mean the release is live.
