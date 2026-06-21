#!/usr/bin/env bash
# Project SessionStart hook — runs in BOTH local and cloud Claude Code sessions.
#
# The branch-tier GIT hooks (pre-commit/pre-push) are a LOCAL-ONLY mechanism (they
# need a global core.hooksPath -> ~/.claude/git-hooks) and do NOT run in a
# cloud/remote session. This reminder re-asserts the discipline that the
# settings.json deny-list and GitHub server-side branch protection enforce.
#
# Plain cat, no `set -e`: a SessionStart hook must never fail the session.

cat <<'EOF'
=== BRANCH-TIER DISCIPLINE (this repo) ===
main is protected. Never commit or push to main directly. Work on a tier branch
(dev/feat/fix/chore/integration/*) and reach main only via a reviewed PR (Gate B).

The git pre-commit/pre-push hooks are local-only and are NOT active in this
environment (e.g. cloud runs). Here, main-protection = the .claude/settings.json
deny-list (blocks main/force pushes) + GitHub server-side branch protection.
Stay on tier branches.
EOF
