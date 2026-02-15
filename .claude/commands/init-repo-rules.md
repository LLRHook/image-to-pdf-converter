# Initialize GitHub Repository Protection Rules

Set up branch protection and CI for the `main` branch. Execute each step in order — stop and report if any step fails.

## Step 1: Verify Prerequisites

Run `gh auth status` to confirm the CLI is authenticated. Run `gh repo view --json nameWithOwner -q .nameWithOwner` to get the repo identifier. If either fails, stop and tell the user to authenticate with `gh auth login`.

## Step 2: Ensure CI Workflow Exists

Check if `.github/workflows/ci.yml` exists in the repo. If it does NOT exist, create it with this content:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
```

If it already exists, read it and confirm it has a job named `build`. If the job has a different name, note it — you'll need that name for the status check in Step 4.

## Step 3: Push CI Workflow to Main

The CI workflow must exist on `main` so GitHub knows about the `build` status check. Check `git status` for uncommitted changes.

- If the CI workflow file is new or modified, stage it, commit with message `"ci: add build check workflow"`, and push to `main`.
- If it's already committed and pushed, skip this step.
- Do NOT stage or commit any other files — only the workflow file.

## Step 4: Apply Branch Protection Rules

Use `gh api` to set branch protection on `main`. Use the repo identifier from Step 1 and the job name from Step 2 (default: `build`).

```bash
gh api \
  --method PUT \
  "repos/{REPO}/branches/main/protection" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["{JOB_NAME}"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
EOF
```

Replace `{REPO}` with the actual `owner/repo` and `{JOB_NAME}` with the CI job name.

## Step 5: Verify

Run `gh api "repos/{REPO}/branches/main/protection"` and confirm the rules are active. Print a summary:

```
Repository: {REPO}
Branch: main

Protection rules applied:
  - PRs required (no direct push to main)
  - 1 approval required, stale reviews dismissed
  - Branch must be up-to-date with main
  - CI "{JOB_NAME}" check must pass
  - Conversations must be resolved
  - Force push blocked
  - Branch deletion blocked
  - Admin bypass: enabled (only bypass allowed)
```

If any rule didn't apply correctly, report the discrepancy.
