#!/bin/bash
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NIGHTWATCH v2 — $(git branch --show-current)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Git status:"
git status --short
echo ""
echo "Last 5 commits:"
git log --oneline -5
echo ""
echo "Current phase (from PLAN.md):"
grep -A3 "## Current Phase" PLAN.md 2>/dev/null | head -4
echo ""
