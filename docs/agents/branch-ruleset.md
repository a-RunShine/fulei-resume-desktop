# Branch ruleset: what a blocked merge does not tell you

Reference for `a-RunShine/fulei-resume-desktop`. Read when a push or a PR merge is refused and the reason is not stated. The GitHub API names the blocking rule only sometimes; the rest of the time the diagnosis is here.

## A write that returns 404 is a permission problem, not a wrong path

`gh api --method PATCH .../rulesets/<id>` returns `404 Not Found` when the token lacks write access to repository rulesets, the same status a genuinely wrong path returns. A `GET` of the same path that succeeds proves the path is right and the write is what is missing. The `repo` scope alone does not grant ruleset writes for this token; the settings change has to be made in the web UI (repo → Settings → Rules) until a token with the right scope exists.

## `REVIEW_REQUIRED` with a zero approval count is the single-maintainer deadlock

The ruleset's `pull_request` rule carries `require_extra_approval_for_unattributed_changes`. The REST documentation scopes it narrowly — an extra approval when Copilot opens a PR with no human collaborator — but on this repository it raises the required approvals back above zero whenever a PR has no approval, and the sole maintainer cannot approve their own PR. The result is `reviewDecision: REVIEW_REQUIRED` and a merge refused with "the base branch policy prohibits the merge" even though `required_approving_review_count` is `0`. Clearing the merge means switching that option off in the ruleset. It is off as of 2026-11-11; a later `REVIEW_REQUIRED` on a zero-approval ruleset is the sign it came back on.

## The blocking reason only surfaces on a real merge attempt

`gh pr view` reports `mergeStateStatus: BLOCKED` and `reviewDecision: REVIEW_REQUIRED` without naming which rule blocks. The refusal message from `gh pr merge` is the first place the specific reason appears ("the base branch policy prohibits the merge"). Reading `gh api .../rules/branches/<branch>` lists the active rules and their parameters but not which one is unsatisfied. Expect to attempt the merge to learn the reason; a refused merge changes nothing.

## Dry runs and non-default branches prove nothing

`git push --dry-run` does not evaluate server-side rules. Pushing to a branch other than `main` is never subject to these rules, so it cannot confirm or refute them. A probe commit on `main` is the only real test; it is refused safely when the rule is active.

## Related

- Merging is the human's call: see the pull-request section of `AGENTS.md`.
- Ruleset ID `25059856`, target `~DEFAULT_BRANCH`, holds `deletion` + `non_fast_forward` + `pull_request`. The two structural rules stay on regardless of the approval count.
