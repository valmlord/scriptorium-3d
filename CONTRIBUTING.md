# Branches, commits and pull requests

Everything below is written in **English**: branch names, commit messages, PR titles and descriptions.
The project has one maintainer, so these rules exist to make the history readable by the person who will
read it without any of the context — which is usually the same person, six months later.

---

## 1. Branching

```
main         ← protected. Green CI required. No direct commits.
   ▲
feat/… fix/… ← all work happens here
```

No `stage` in this project: it is a static site with no environments to integrate, so an intermediate
branch would add a merge without protecting anything. `main` is what deploys to Pages.

A new feature means a new branch, cut from current `main`:

```bash
git switch main && git pull
git switch -c feat/core-feistel-bijection
```

### Naming

`<type>/<scope>-<short-description-in-kebab-case>`

| Type | Use for |
|---|---|
| `feat` | new functionality |
| `fix` | bug fix |
| `refactor` | code change with no behavioural change |
| `perf` | optimisation |
| `test` | tests only |
| `docs` | documentation only |
| `chore` | infrastructure, dependencies, CI |

`<scope>` is a layer or area: `core`, `worker`, `engine`, `motion`, `state`, `ui`, `app`, `infra`, `ci`,
`docs`.

A branch lives days, not weeks. If the work does not fit, split it across pull requests.

---

## 2. Commits

### Format — Conventional Commits

```
<type>(<scope>): <imperative summary, max 72 characters>

<body: what changed and, more importantly, WHY. Expected for anything non-trivial>

<footer: Refs #12, BREAKING CHANGE: …>
```

Subject rules: imperative mood (`add`, `fix`, `move` — not `added`), lower case after the colon, no
trailing full stop.

```
feat(core): replace modular multiplication with a Feistel network

A linear bijection leaks its structure into the text: neighbouring
addresses produce correlated pages, so walking one shelf shows a pattern
where the premise of the library requires none. Ten rounds of a balanced
Feistel cost ~0.5 ms more and remove it.

Refs ADR-0002
```

### Atomic commits

1. One commit, one logical change.
2. The project builds and tests pass after every commit. No intermediate broken states — any single commit
   can be reverted on its own.
3. A change and its tests ship in the same commit, not "feature" then "tests for feature".
4. Formatting never rides along with logic.

Rewriting history on your own branch before the PR is open is normal. After anyone has seen it, it is not.

### What must never enter history

- Subjects that say nothing: `fix`, `update`, `wip`, `.`
- Commented-out code, leftover `console.log`.
- Tooling footers and boilerplate trailers that carry no information about the change.
- Secrets, IDE files, `node_modules`, build artefacts.
- Regenerated golden vectors passed off as a fix (see ADR-0003).

---

## 3. Pull requests

Title uses the commit subject format. The description follows
[`.github/pull_request_template.md`](.github/pull_request_template.md), filled with substance rather
than "did what was asked".

### Before merging

- [ ] CI is green. **A red pipeline never merges** — not "flaky", not "I'll fix it after".
- [ ] Complies with [`architecture.md`](docs/architecture.md) and [`code-style.md`](docs/code-style.md).
- [ ] No divergence from [`SPEC.md`](docs/spec.md), or the spec changes in this same PR.
- [ ] Non-trivial decisions recorded in [`DECISIONS.md`](docs/decisions.md).
- [ ] New logic covered by tests; the bijection and the address model are mandatory.
- [ ] The milestone's review gate in [`ROADMAP.md`](docs/roadmap.md) has been answered.
- [ ] You can explain every line of the diff.

**Squash and merge.** `main` history then reads as a list of features. The squash message follows the same
rules as any commit.
