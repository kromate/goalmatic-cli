# Goalmatic developer tools

Create Vue Sites and authenticated Apps, connect a GitHub repository, and manage
previews and releases from your terminal. Both starters contain a todo example.

This checkout is the source for `goalmatic` and `create-goalmatic`. The public beta
uses the `beta` npm dist-tag. The CLI and its Goalmatic API remain beta software.

## Get started

Use Node.js 22.12 or later.

```sh
npx goalmatic@beta --help
```

The public installation command is:

```sh
npm create goalmatic@beta my-todo
```

Connected setup opens Goalmatic for browser sign-in. Choose your account, create or
link a project, and connect a GitHub repository. Credentials stay in the local user
configuration directory. Each project records its own account and project IDs.

An App uses Goalmatic authentication and Tables when hosted. Local App development
uses a labeled Demo whose tasks reset on refresh. The Site starter also keeps
tasks in page memory and resets on refresh, both locally and when hosted.

## Work on the packages

`packages/cli` contains the commands and Vue template. `packages/create-goalmatic`
contains the npm initializer. `docs` contains the Mintlify documentation.

Use `npm run pack:inspect` to inspect the publication file lists. The packages do
not need a compilation step. The bundled todo is ordinary Vue and Vite source.

## Publish documentation without a subscription

Connect the `docs` directory of the source repository to Mintlify's free Starter
plan at [goalmatic.mintlify.site](https://goalmatic.mintlify.site). Keep the
provided Mintlify URL to avoid buying a domain. Do not start a paid trial, upgrade
a plan, or enable metered AI features for this project.

The CLI and todo use no paid generation services. Goalmatic accounts remain
subject to the platform's existing hosting and data limits. Public npm package
publication does not require a paid private-package plan.

## Release status

Read the [release guide](docs/contributing-and-releasing.mdx) for beta publication
requirements. Publishing a Site, creating an App test build, submitting an App
release, publishing an npm package, and deploying these docs are separate operations.
