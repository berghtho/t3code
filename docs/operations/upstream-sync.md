# Daily Upstream Synchronization

This runbook keeps `berghtho/t3code` current with `pingdotgg/t3code` without allowing stock T3 Code
to overwrite CMD Riker's product authority or fork-only capabilities. Execute it before product work
in the first available session of each UTC day. Running the no-change check more than once is safe.

The unit of integration is one reviewed batch from `upstream/main`, not a collection of individually
cherry-picked pull requests. Merging the source branch preserves ancestry, prevents already-integrated
source commits from returning in later batches, and gives the fork one auditable pull request per day.

## Authority and invariants

`upstream/main` is authoritative only for incoming stock T3 Code changes. The fork remains
authoritative for CMD Riker integration, product identity, supported capabilities, governance, and
release safety.

Every sync must preserve these invariants:

- All publication targets remain under `berghtho/t3code`; `pingdotgg/t3code` remains fetch-only.
- T3 remains a presentation integration for the authoritative CMD Riker Lead Agent. It must not
  acquire a competing workflow model or launch Worker Sessions on the Lead Agent's behalf.
- T3 clients send only a branded `projectId`; the server resolves and canonicalizes the configured
  Target Project path before invoking `riker gateway --project <path>`.
- The Owner Gateway remains project-isolated, versioned, authenticated, and free of child-process
  details in client-visible errors.
- Stock T3's provider list is not CMD Riker's Native Harness policy. CMD Riker supports Native
  Harnesses stock T3 does not, including GitHub Copilot. A sync must not narrow that set, gate Riker
  through a stock-provider enum, or remove generic seams required for those harnesses.
- The fork boundary at the top of `AGENTS.md`, the public downstream notice, fork-local support
  routes, disabled-Actions policy, and first-release gate remain effective.
- GitHub Actions stays disabled at repository level. Incoming workflow files are inert source code;
  merging them never authorizes enabling or running them.

Absence upstream is not evidence that a Riker capability should be removed. When source architecture
changes around a fork capability, adapt the capability to the new architecture and retain its tests.

## Daily ownership

The Lead Agent owns the sync outcome and all stop-condition and merge decisions under its Command
Authority. It may delegate review, conflict resolution, and verification to Worker Sessions, but this
runbook grants a Worker Session no independent Command Authority and no publication credentials.

The Owner's instruction recorded here is standing authorization for the Lead Agent to create and
merge a fork-local sync pull request without asking again when there are no stop conditions and all
review and verification gates pass. It does not authorize publishing to upstream, enabling Actions,
changing release identity, or merging a degraded product.

One session owns at most one open `upstream-sync` pull request. Before creating a branch, query the
fork for an open pull request carrying the `upstream-sync` label. Resume it first, even when it was
opened on an earlier date. Do not create parallel sync pull requests.

## 1. Preflight

Use a clean checkout. If the current checkout contains unrelated work, leave it untouched and use a
clean worktree based on `origin/main`; never stash, reset, or discard somebody else's changes.

Verify all of the following before fetching or publishing:

```bash
git status --short --branch
git remote -v
git config --get remote.pushDefault
git config --get-all remote.upstream.fetch
git config --get remote.upstream.tagOpt
git config --get remote.upstream.pushurl
gh repo view --json nameWithOwner,defaultBranchRef
gh api repos/berghtho/t3code/actions/permissions
gh api repos/berghtho/t3code/branches/main/protection
gh pr list --repo berghtho/t3code --state open --label upstream-sync --json number,baseRefName,headRefName,headRepositoryOwner,isDraft,url
```

The required values are:

- `origin` fetches from and pushes to `berghtho/t3code`.
- `upstream` fetches from `pingdotgg/t3code` and has push URL `DISABLED`.
- `upstream` fetches only `refs/heads/main` and has tag option `--no-tags`.
- `remote.pushDefault` is `origin`.
- GitHub CLI resolves to `berghtho/t3code` with default branch `main`.
- Repository Actions permissions report `"enabled": false`.
- Branch protection requires pull requests and strict up-to-date branches, applies to administrators,
  requires resolved conversations, and blocks force-pushes and deletion.

Stop and repair the local safeguards before continuing if any value differs. Always pass
`--repo berghtho/t3code` to GitHub CLI commands that create or mutate remote state.

Fetch only the two canonical branches. Do not base a sync on an upstream feature or pull-request
ref.

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main --no-tags
git fetch upstream +refs/heads/main:refs/remotes/upstream/main --no-tags
```

If `git rev-parse --is-shallow-repository` reports `true`, fetch the complete source ancestry once
before making ancestry decisions:

```bash
git fetch origin --unshallow +refs/heads/main:refs/remotes/origin/main --no-tags
git fetch upstream +refs/heads/main:refs/remotes/upstream/main --no-tags
git rev-parse --is-shallow-repository
git merge-base origin/main upstream/main
```

The shallow check must now report `false`, and the merge-base command must return a commit. Stop
rather than treating missing ancestry as a new or unrelated source history.

### Resume path

When the preflight query returns an open sync pull request, do not continue to the new-branch path.
There must be exactly one such pull request, based on `main`, owned by `berghtho`, with a head named
`upstream-sync/*`. Inspect its body for the recorded upstream SHA, then check it out:

```bash
gh pr view <number> --repo berghtho/t3code --json number,baseRefName,headRefName,headRefOid,headRepositoryOwner,commits,body,url
gh pr checkout <number> --repo berghtho/t3code
git log --graph --oneline --decorate origin/main..HEAD
git merge-base --is-ancestor <recorded-upstream-sha> HEAD
```

Verify that an integration merge has the recorded upstream SHA as its second parent and that every
other commit is documented conflict resolution or incorporation of a newer fork base. Stop if the
head repository, parents, commits, or body do not prove that provenance. Fetch `origin/main`; if the
branch does not contain it, merge the new fork base into the sync branch and repeat all affected
review and verification. Resume at the appropriate later section instead of creating another branch.

If `git merge-base --is-ancestor upstream/main origin/main` succeeds, the fork already contains the
current upstream head. End the daily sync with no commit or pull request. Never create no-op history.

## 2. Inventory the incoming batch

When upstream has advanced, record the output of these comparisons before merging:

```bash
git rev-parse upstream/main
git merge-base origin/main <upstream-sha>
git log --oneline <last-common-sha>..<upstream-sha>
git log --first-parent --oneline <last-common-sha>..<upstream-sha>
git diff --stat <last-common-sha>..<upstream-sha>
git diff --name-status <last-common-sha>..<upstream-sha>
```

Use the commit subjects and linked source pull requests to understand intent, not just the final
diff. Record the exact upstream head SHA. That fixed SHA defines the batch; commits arriving after
the inventory belong to the next daily sync.

Classify the changed areas and apply the corresponding review:

| Area                                                                                    | Required review                                                                                       |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Riker bridge, contracts, RPC, authorization, project resolution, or WebSocket lifecycle | Prove all Riker invariants and run the complete Riker baseline.                                       |
| Provider, model, orchestration, or agent selection                                      | Check the capability delta explicitly, including Copilot and any Native Harness absent from stock T3. |
| Persistence, projections, or migrations                                                 | Review forward and restart behavior; run focused migration and projection tests.                      |
| Authentication, remote access, subprocesses, or filesystem boundaries                   | Review trust boundaries and run focused security/error-path tests.                                    |
| Dependencies, build, packaging, updates, release code, or `.github/workflows/**`        | Review install scripts and destinations; preserve disabled Actions and the release gate.              |
| Product names, IDs, paths, URLs, telemetry, OAuth, or cloud resources                   | Preserve the fork's independent identity decisions; never restore a stock publication target.         |
| Governance, support routes, `AGENTS.md`, or public documentation                        | Preserve the fork boundary while incorporating useful upstream guidance.                              |
| Web, desktop, or mobile behavior                                                        | Check all affected surfaces and run the smallest relevant tests for each.                             |

Review files with changes on both sides particularly carefully. The standing fork-owned surface
currently includes:

- `apps/server/src/riker/**`
- `packages/contracts/src/leadAgent*`
- Riker additions in contracts exports, RPC authorization, server layers, and WebSocket handlers
- `docs/internals/lead-agent.md`
- `AGENTS.md`, `docs/internals/downstream-fork.md`, this runbook, and fork-local GitHub templates
- Product identity and release configuration as those fork-specific decisions land

This list is a review trigger, not permission to keep an entire file unchanged. Incorporate compatible
upstream improvements around the fork-owned behavior.

## 3. Build the integration branch

Create the branch from the latest fork `main`, using the current UTC date:

```bash
git show-ref --verify refs/heads/upstream-sync/YYYY-MM-DD
git ls-remote --exit-code --heads origin upstream-sync/YYYY-MM-DD
git switch -c upstream-sync/YYYY-MM-DD origin/main
git merge --no-ff --no-commit <recorded-upstream-sha>
```

The first two commands are expected not to find a branch. If either finds one while no labeled pull
request exists, inspect and resume it only after proving its provenance. Never overwrite it. If it has
no unique work, remove it only after that fact is confirmed, then restart the new-branch path.

Do not rebase fork `main`, squash the source history, or cherry-pick each source pull request. Do not
use blanket `ours` or `theirs` conflict resolution. Resolve each conflict according to intent:

- Preserve fork governance and Riker capabilities while incorporating compatible upstream text or
  architecture.
- Adapt Riker call sites when upstream moves or reshapes their surrounding seam.
- Accept ordinary upstream changes in areas the fork has not changed after reviewing their source
  pull requests.
- Resolve package manifests first and defer lockfile regeneration to the isolated verification
  context; never hand-splice generated lockfile sections.
- Keep workflow changes inert. Never change repository Actions settings as part of a sync.

Inspect both the incoming range and the combined result:

```bash
git rev-parse <recorded-upstream-sha>
git rev-parse MERGE_HEAD
git diff --cached --check
git diff --cached --stat
git diff --cached --name-status
git status --short
```

The `MERGE_HEAD` and recorded upstream SHAs must match. After verification, commit the merge with a
message that records the short upstream SHA, for example
`git commit -m "chore(upstream): sync through a3a8cbd6"`. Then inspect the committed result with
`git diff --stat origin/main...HEAD` and `git diff --name-status origin/main...HEAD`.

## 4. Verify the combined product

GitHub Actions is disabled, so the Lead Agent owns verification. Treat incoming scripts, tool
configuration, dependencies, and test code as untrusted until their source diff has been reviewed.
Delegate executable checks to an isolated Worker Session and Execution Checkout without GitHub write,
release, cloud, production, or other externally binding credentials. Publication happens later from
the Lead Agent's credentialed context. Stop if credential isolation cannot be established for an
incoming executable change. All package-manager operations, including installation and lockfile
regeneration, happen only in that isolated context.

Run the smallest relevant tests for every incoming area plus this mandatory Riker baseline:

```bash
vp test run packages/contracts/src/leadAgent.test.ts apps/server/src/riker/LeadAgentProjectResolver.test.ts apps/server/src/riker/RikerOwnerGateway.test.ts apps/server/src/riker/LeadAgentBridge.test.ts
vp test run apps/server/src/server.test.ts -t "Lead Agent"
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
git diff --check
```

Run targeted lint and formatting checks on all changed TypeScript and TSX files. Run focused package
tests for every changed behavior; do not substitute the Riker baseline for upstream's own relevant
tests. If manifests or the lockfile changed, install with the repository package manager and verify
that the installation does not introduce an unexplained diff.

The contracts baseline contains an unconditional capability-boundary regression: Owner turns expose
no stock provider or Native Harness selection to T3. Every sync runs it, even when the incoming file
classification appears unrelated.

For every sync, verify explicitly that:

- Lead Agent turns still cross the presentation boundary without being interpreted as stock T3
  provider turns.
- No stock provider or model enum controls CMD Riker's Native Harness selection.
- Copilot remains available to CMD Riker under its Model Policy even though stock T3 lacks a Copilot
  adapter.
- Project isolation, reconnect behavior, authorization, and sanitized failure behavior still pass.

Add a focused regression test whenever preserving a fork invariant requires non-obvious conflict
resolution. Do not weaken or delete a test merely to make the batch green.

## 5. Stop conditions

Do not merge when any of these conditions is true:

- A conflict cannot be resolved with confidence while retaining a fork invariant.
- Upstream architecture appears to require removing or narrowing a Riker capability.
- A failing test cannot be shown to be unrelated and already tracked.
- A migration risks existing fork state without a tested forward path.
- The combined change enables Actions, publishes externally, restores a stock identity collision, or
  requires a credential or infrastructure decision.
- The batch is too broad to review reliably in one session.

When the index still has unresolved conflicts, file a fork issue with the upstream SHA and conflict
details, then abort only this attempted merge. An unresolved index cannot be represented by a useful
remote pull request. When the result is coherent enough to commit but a decision or verification is
still blocked, push the integration branch only to `berghtho/t3code`, open or retain a draft pull
request labeled `upstream-sync`, and link the blocking fork issue. Later daily sessions resume that
pull request and may update it to a newer upstream head only after the blocker is understood. Never
bypass a difficult source commit by merging later source commits around it.

## 6. Publish and merge

Push explicitly to the fork and open a pull request against the fork:

```bash
gh api repos/berghtho/t3code/actions/permissions
git push -u origin upstream-sync/YYYY-MM-DD
gh pr create --repo berghtho/t3code --base main --head upstream-sync/YYYY-MM-DD --title "chore(upstream): sync YYYY-MM-DD" --label upstream-sync
```

Do not push unless Actions permissions still report `"enabled": false`.

The pull-request body must record:

- Previous integrated upstream SHA and new upstream SHA.
- Every upstream commit and source pull request in the batch.
- Risk classification and review notes.
- Conflicts and how fork behavior was preserved.
- The capability-delta result, explicitly confirming the provider-agnostic boundary and Copilot.
- Exact verification commands and outcomes.
- Confirmation that Actions stayed disabled and all publication targets stayed fork-local.
- The model and Native Harness that performed the sync.

Review the remote diff and destination after pushing. Immediately before merging, fetch
`origin/main`. The tested integration head must contain that exact base commit. If it does not, merge
the new base into the sync branch, push normally, and repeat affected review and all mandatory
verification. Capture the final tested head SHA and require GitHub to merge exactly that head.
Repository branch protection must still require an up-to-date branch so GitHub rejects a merge if the
base advances after this local check.

When every gate passes and no stop condition is present, merge with a merge commit and delete the
branch:

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main --no-tags
git merge-base --is-ancestor origin/main HEAD
gh pr view <number> --repo berghtho/t3code --json baseRefName,headRefName,headRefOid,headRepositoryOwner,mergeable,reviewDecision,statusCheckRollup,url
gh pr diff <number> --repo berghtho/t3code
gh api repos/berghtho/t3code/actions/permissions
gh api repos/berghtho/t3code/branches/main/protection
gh pr ready <number> --repo berghtho/t3code
gh pr merge <number> --repo berghtho/t3code --merge --delete-branch --match-head-commit <tested-head-sha>
```

Skip `gh pr ready` when the pull request is already ready. Actions must still report `"enabled":
false`, and branch protection must still require the tested branch to be up to date. If either
safeguard differs, stop before the merge.

Never use squash or rebase merge for an upstream sync; either would discard the source-parent
ancestry used to calculate the next batch.

## 7. Verify completion

Fetch the merged fork head and prove both histories are present:

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main --no-tags
git merge-base --is-ancestor <recorded-upstream-sha> origin/main
git merge-base --is-ancestor <tested-head-sha> origin/main
gh pr view <number> --repo berghtho/t3code --json state,mergedAt,mergeCommit,url
git status --short --branch
```

Both ancestry commands must succeed, the pull request must report `MERGED` with a merge commit, and
the checkout must be clean. Report the fork pull request URL, merge commit, integrated upstream SHA,
conflicts, capability-delta result, and verification evidence. The next daily session starts from
this recorded ancestry.
