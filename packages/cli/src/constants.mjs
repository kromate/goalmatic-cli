export const VERSION = '0.1.0-beta.1'
export const DEFAULT_API_ORIGIN = 'https://goalmatic.site'
export const CONFIG_FILE = 'goalmatic.json'
export const SETUP_RECEIPT = '.goalmatic/local/setup.json'

export const HELP = `Goalmatic CLI ${VERSION}

Usage: goalmatic <command> [options]

Commands:
  login                 Sign in through the Goalmatic browser flow
  logout                Revoke the saved credential and sign out locally
  whoami                Show the signed-in user
  accounts              List accessible accounts
  projects              List projects in an account
  create [directory]    Create a Vue Site or App and its Goalmatic project
  link <project-id>      Link an empty directory to an existing project
  git connect           Connect the project to a GitHub repository
  git status            Show GitHub source status
  status                Show project, source, and deployment state
  dev                   Run the project's npm dev script
  deploy --preview      Create a preview deployment from the pinned source
  publish               Publish a Site or submit an App release for review

Global options:
  --api-url <origin>     Use HTTPS, or loopback HTTP for local development
  --json                 Print machine-readable output
  --yes                  Accept an exact non-interactive choice where supported
  --local                Scaffold without login or remote project creation
  --help                 Show help
  --version              Show the CLI version

Authentication:
  Interactive login stores credentials in ~/.config/goalmatic with restricted
  permissions. GOALMATIC_TOKEN can supply a CI token and is never persisted.
`
