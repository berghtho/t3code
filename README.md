# CMD Riker Desktop

> [!IMPORTANT]
> This is the canonical public repository for CMD Riker's independent downstream fork of T3 Code.
> It is MIT-licensed and can be used, modified, and built independently. It is not an official T3
> Code distribution, and Riker-specific changes remain in this fork. See
> [the downstream fork policy](docs/internals/downstream-fork.md).

CMD Riker Desktop is the presentation interface for CMD Riker. It builds on T3 Code's fast,
remote-ready clients while keeping CMD Riker authoritative for conversation, orchestration, projects,
and agent work.

The fork is available for source use today. A packaged CMD Riker Desktop release has not been
published yet; inherited `npx`, desktop, mobile, and package-manager installation links install stock
T3 Code and do not include Riker-specific behavior.

The upstream T3 Code project is an "agent harness control surface". It enables control of the agents
on your machine with a mobile app
([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)),
[web app](https://app.t3.codes), and [Electron-based desktop app](https://t3.codes).

Stock T3 Code works with Claude Code, Codex, Cursor, Grok Build, and OpenCode subscriptions. CMD
Riker Desktop instead presents work owned and orchestrated by CMD Riker through its Lead Agent
integration.

## Why T3 Code

T3 Code provides a performant, remote-ready, multi-client foundation for working with coding agents.
CMD Riker maintains this fork to preserve those strengths while building a dedicated presentation
surface around CMD Riker's own authority and workflow model. The full source remains open so users
can inspect it, run it, and adapt it.

## Installation

### Use this fork from source

CMD Riker Desktop currently runs from source. Install `vp` and the repository dependencies as
described under [Development](#development), then start the local server and web client:

```bash
vp run dev
```

Development state is isolated under this checkout's `.t3` directory. You will also need a supported
and authenticated provider CLI for stock T3 workflows, or a compatible CMD Riker core for
Riker-specific integration.

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try stock T3 Code (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest stock T3 Code version from the
[source repository's releases](https://github.com/pingdotgg/t3code/releases), or from your favorite
package registry. These packages do not include Riker-specific changes:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Project status

CMD Riker Desktop is early and currently intended for source use. Expect bugs and unfinished release
surfaces.

We are not actively accepting unsolicited contributions yet. Small, focused fixes may be considered;
read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Development

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Report CMD Riker Desktop bugs in this repository's
[issue tracker](https://github.com/berghtho/t3code/issues).

Have a feature request? Start an
[Ideas discussion](https://github.com/berghtho/t3code/discussions/categories/ideas).
