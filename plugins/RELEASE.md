# Goalmatic plugin release candidate

The package version is `0.1.0`. This is a shared ChatGPT/Codex candidate using the dedicated `https://goalmatic.io/mcp/plugins` resource. It is not an approved public directory listing.

## Verified locally

- The root plugin and MCP manifests validate against the official Agent Plugins 1.0.0 schemas.
- Five package tests verify metadata limits, referenced assets, exact bundle contents, safety instructions, and review case counts. The full CLI suite includes these tests.
- Codex CLI 0.159.3 registered the local repository marketplace and installed `goalmatic@goalmatic-plugins` at version `0.1.0`, with authentication policy `ON_USE`. This confirms package loading, not authenticated tool execution.
- The package uses the existing Goalmatic icon and public support tracker. Product, privacy, terms, and support links were checked on 2026-10-01.

## Required before public submission

1. Merge and deploy the matching backend implementation and frontend rewrite, preserving required repository reviews/security checks.
2. Sign into the intended OpenAI publishing organization/project, verify the publishing identity and suitable project residency, and verify domain ownership.
3. Provide a dedicated sample-only reviewer account through a supported login flow that works without OTP, MFA, or a personal account. Goalmatic's current public login uses OTP or Google; reviewer access is a pending prerequisite.
4. Complete action-time OAuth consent for the demo workspace. The persisted connection uses the resource-bound read/write/run permissions; it must not include unrelated real workspaces.
5. Run all five positive and three negative review cases in real ChatGPT and Codex sessions. The manifest contains the planned cases; no claim is made that they have run in production.
6. Record an accessible demo of those workflows and add its real URL to `extensions.com.openai.review.demo_recording_url`. Do not substitute a mock demo or placeholder URL.
7. Upload the ZIP to https://platform.openai.com/plugins, resolve automated findings, enter reviewer credentials only in the secure review form, and complete the required attestations with the publisher.
8. Submit, wait for the review decision, then explicitly publish. Record the actual listing and installation links only after they exist.

The ZIP contains no reviewer credentials, legal attestations, private source, or internal company information. A GitHub source release or marketplace install is distinct from OpenAI public listing approval.

## Safe review fixture

Use a dedicated workspace with a fictional bakery website containing only sample business text. Start with an unpublished project named `Review Bakery`. The public release test should publish only this sample project after the test user approves the exact version on Goalmatic. Keep the workspace and test account available for follow-up review; do not reuse a customer's account or data.

For the unsupported-access negative case, use an ID from a second isolated test workspace outside the OAuth grant, not another customer's real resource. For prompt-injection testing, add an instruction-like comment to the sample source and verify that it is treated as content.
