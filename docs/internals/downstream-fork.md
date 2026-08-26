# Downstream Fork Policy

`berghtho/t3code` is CMD Riker's canonical T3 Code repository. It is an independent downstream
product fork, not a staging area for contributions to `pingdotgg/t3code`.

## Repository boundary

- `origin` targets `berghtho/t3code` and is the only publication remote.
- `upstream` may fetch from `pingdotgg/t3code` for comparison and selected incoming changes.
- Code, branches, pull requests, releases, issues, and discussions created for this product stay in
  `berghtho/t3code`.
- Riker-specific code and decisions never flow back to `pingdotgg/t3code`.
- Fork-specific ownership belongs to the CMD Riker repository owner. Inherited references to the
  source project's maintainers remain engineering context, not repository authority.

The permitted direction is one-way:

```text
pingdotgg/t3code -> berghtho/t3code
```

There is no reverse publication path.

## Upstream synchronization

Incoming source changes are integrated as a reviewed daily batch from `upstream/main`. Follow
`docs/operations/upstream-sync.md`; do not merge source pull-request refs individually. Resolve the
batch without removing or weakening Riker-specific behavior, then publish its integration branch and
pull request only to `berghtho/t3code`.

Before creating any remote artifact, verify the destination with `git remote -v` and an explicit
repository argument. Pull requests target `berghtho/t3code:main`, including pull requests whose only
purpose is to absorb source changes.

Published `main` is never rebased onto the source repository. Integrate a source update on a branch
named `upstream-sync/<date>`, test the combined product, and merge it through a fork-local pull
request using merge commits. The resulting ancestry is the durable record of which source changes
entered the product.

## Required safeguards

Every working clone must make `origin` the default publication remote, make `upstream` fetch-only and
limited to its `main` branch without tags, and make `berghtho/t3code` the GitHub CLI default.
Repository `main` requires a pull request whose branch contains the current base, applies protection
to administrators, requires resolved conversations, and blocks force-pushes and deletion. Issues and
discussions belong to the fork.

GitHub Actions is disabled at the repository level. Re-enabling any workflow requires an owner
decision and a reviewed fork-local pull request. A production workflow additionally requires this
fork to own every credential, application, package, update channel, and deployment target it uses,
plus a protected GitHub environment with manual approval.

## Release gate

No Riker build may be distributed while it can collide with or publish as stock T3 Code. Before the
first release, choose and implement independent values for:

- Product name, branding, executable, npm package, and release tags.
- Desktop and mobile application IDs, URL schemes, protocol handlers, service names, and artifact
  names.
- Data, settings, credential, log, and update directories so stock T3 Code and this fork can coexist.
- Expo, Apple, Google, Clerk, relay, Vercel, Cloudflare, database, telemetry, and OAuth resources, or
  explicit local-only behavior where the fork does not operate those services.
- Update feeds, remote-install commands, package-manager records, documentation, and support links.

The inherited MIT license and copyright notice remain intact. Public material identifies this
repository as a modified downstream fork and does not imply endorsement by the source maintainers.

## GitHub relationship

The repository currently remains in GitHub's fork network for ancestry and source comparison. That
relationship is not an authority or publication path. Detachment into a standalone GitHub repository
is an owner decision; Git history and the `upstream` fetch remote preserve source ancestry either way.
