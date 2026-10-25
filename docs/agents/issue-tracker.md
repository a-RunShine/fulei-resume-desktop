# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on the fork `a-RunShine/fulei-resume-desktop`. Use the `gh` CLI for all operations. Do not open issues on upstream `reactive-resume/reactive-resume`.

## Conventions

Pass `--repo a-RunShine/fulei-resume-desktop` on every issue command. `gh` in this clone resolves the parent repository, so omitting `--repo` opens issues on upstream.

- **Create an issue**: `gh issue create --repo a-RunShine/fulei-resume-desktop --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo a-RunShine/fulei-resume-desktop --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo a-RunShine/fulei-resume-desktop --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo a-RunShine/fulei-resume-desktop --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo a-RunShine/fulei-resume-desktop --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo a-RunShine/fulei-resume-desktop --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --repo a-RunShine/fulei-resume-desktop --comments` and `gh pr diff <number> --repo a-RunShine/fulei-resume-desktop` for the diff.
- **List external PRs for triage**: `gh pr list --repo a-RunShine/fulei-resume-desktop --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`, each with `--repo a-RunShine/fulei-resume-desktop`.

GitHub shares one number space across issues and PRs. Resolve bare `#42` with `gh pr view 42 --repo a-RunShine/fulei-resume-desktop`, then fall back to `gh issue view 42 --repo a-RunShine/fulei-resume-desktop`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo a-RunShine/fulei-resume-desktop --comments`.

## Wayfinding operations

Used by `/wayfinder`. Map is one issue with child issues as tickets.

- **Map**: issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog. Create with `gh issue create --repo a-RunShine/fulei-resume-desktop --label wayfinder:map`.
- **Child ticket**: issue linked as a GitHub sub-issue. Where sub-issues are unavailable, add it to a task list in map body and put `Part of #<map>` atop child body. Labels: `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Assign ticket to driving developer once claimed.
- **Blocking**: use GitHub native issue dependencies. Add with `gh api --method POST repos/a-RunShine/fulei-resume-desktop/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where database ID comes from `gh api repos/a-RunShine/fulei-resume-desktop/issues/<n> --jq .id`. Where unavailable, use `Blocked by: #<n>, #<n>` atop child body.
- **Frontier query**: list map’s open children, drop assigned tickets and tickets with open blockers, then select first in map order.
- **Claim**: `gh issue edit <n> --repo a-RunShine/fulei-resume-desktop --add-assignee @me`.
- **Resolve**: comment with answer, close child, then append context pointer to map’s Decisions-so-far.
