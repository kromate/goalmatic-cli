---
name: get-started
description: Connect Goalmatic and choose a workspace when the user wants to create, edit, preview, or publish a Goalmatic website or simple App project.
---

Use the Goalmatic connection's individually named project tools.

1. Call `list_workspaces`. If authentication is required, use the host's Connect flow. The user signs in on Goalmatic and selects workspaces and permissions. Never ask for passwords, tokens, or OAuth codes in chat.
2. Use the workspace the user names. If several workspaces fit and no default or context resolves it, ask which workspace to use. Never guess IDs or substitute an unrelated workspace after an access error.
3. Call `list_projects` when the task concerns an existing project. Follow pagination when needed. Use project IDs and links returned by Goalmatic.
4. For a new project, follow the build-project skill. A draft is a useful first outcome; publishing is a separate action that requires approval on Goalmatic.

This plugin supports authored HTML/Vue projects, source edits, stored checks, previews, and deployment status. It does not provide WhatsApp alerts, payments, reminders, calendar synchronization, App installation, App Store distribution, or arbitrary operation execution. Do not infer that sharing a workspace synchronizes records between Apps.

A connection can be revoked in Goalmatic at https://goalmatic.io/settings/ai-connections. Permissions apply only to the workspaces selected during OAuth consent. Reconnect through the host if the user needs to change them.
