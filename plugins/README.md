# Goalmatic for ChatGPT and Codex

One portable package provides the Goalmatic project tools and two workflow skills for supported ChatGPT and Codex clients. It uses a remote, first-party MCP server at `https://goalmatic.io/mcp/plugins`; the existing general-purpose `/mcp` endpoint is a separate integration.

## Release status

This is a release candidate. Source availability and local installation do not mean that the endpoint is deployed, that OAuth QA has completed, or that the plugin is publicly listed. See `RELEASE.md` for the required release evidence and outstanding gates.

## Install from this repository

With a Codex version supporting plugin marketplaces:

```sh
codex plugin marketplace add kromate/goalmatic-cli
codex plugin add goalmatic@goalmatic-plugins
```

Connect Goalmatic through the host's OAuth flow on first use. Choose the workspace and permissions you intend to grant. For local development, run `codex plugin marketplace add /absolute/path/to/goalmatic-cli` against your checkout. These commands register a repository marketplace; they do not publish to the public Plugins Directory.

Public distribution uses one shared directory listing for ChatGPT and Codex after OpenAI review and explicit publication. The Codex IDE extension does not currently load plugins. Clients that support remote MCP without plugin packages can connect to the same endpoint and load the skills separately if supported.

## Tools

| Tool | Effect |
| --- | --- |
| `list_workspaces` | Read consented workspaces and current roles |
| `list_projects` | Read workspace project summaries |
| `get_project` | Read project, preview/editor links, and deployment details |
| `create_project` | Save a draft with authored HTML or Vue files |
| `read_project_files` | Read source and current version |
| `update_project_files` | Set/delete draft files with a revision check |
| `get_project_quality` | Read stored quality checks |
| `publish_project` | Publish an exact version after Goalmatic approval |
| `get_deployment` | Read deployment progress and result |

The plugin has no payment, messaging, App-installation, App Store submission, or arbitrary-operation tools. Project publication makes content public. Source writes require stable idempotency keys, and updates require a base version. Access is limited to selected workspaces and remains subject to current membership and project ownership.

## Package and validate

```sh
npm run test:plugin
npm run pack:plugin
```

The ZIP contains only the portable manifest, remote MCP configuration, skills, and existing Goalmatic brand asset. It contains no credentials, reviewer account details, private backend source, or private company materials. The backend implementation is maintained separately in Goalmatic.

Current official guides: [package format](https://developers.openai.com/plugins/build/plugins), [submission](https://developers.openai.com/plugins/deploy/submission), [authentication](https://developers.openai.com/plugins/build/auth), [guidelines](https://developers.openai.com/plugins/plugin-guidelines).
