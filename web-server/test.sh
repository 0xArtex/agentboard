#!/bin/bash
# Quick smoke test for the web server via curl.
# Usage: Start server first (node server.js), then run: bash test.sh
#
# The authoritative test suite is scripts/smoke-test-*.js — this shell
# script is a lightweight sanity check for the read-only endpoints the
# Storyboarder web bundle needs, plus a minimal agent API ping.

BASE="http://localhost:3456"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local status="$2"
  local expected="$3"
  if [ "$status" = "$expected" ]; then
    echo "  ✅ $desc"
    ((PASS++))
  else
    echo "  ❌ $desc (got $status, expected $expected)"
    ((FAIL++))
  fi
}

echo ""
echo "🧪 AgentBoard — Web Server Sanity Check"
echo "================================================"

# Health
echo ""
echo "── Health ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")
check "GET /api/health" "$STATUS" "200"

# Preferences (used by electron-shim)
echo ""
echo "── Prefs ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/prefs")
check "GET /api/prefs" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" \
  -d '{"enableAutoSave": false}' "$BASE/api/prefs")
check "PUT /api/prefs" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/prefs/enableAutoSave")
check "GET /api/prefs/enableAutoSave" "$STATUS" "200"

# Projects (read-only — create goes via /api/agent/create-project)
echo ""
echo "── Agent API ──"

AGENT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"title": "Smoke Test", "boards": [{"dialogue": "board 1"}, {"dialogue": "board 2"}]}' \
  "$BASE/api/agent/create-project")
AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$AGENT_ID" ]; then
  echo "  ✅ POST /api/agent/create-project → id: $AGENT_ID"
  ((PASS++))
else
  echo "  ❌ POST /api/agent/create-project — no ID"
  echo "     Response: $AGENT_RESPONSE"
  ((FAIL++))
fi

# Storyboarder web bundle endpoints
echo ""
echo "── Web bundle endpoints ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$AGENT_ID")
check "GET /api/projects/:id" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$AGENT_ID/files")
check "GET /api/projects/:id/files" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/current")
check "GET /api/projects/current" "$STATUS" "200"

# Share URL
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/agent/share/$AGENT_ID")
check "GET /api/agent/share/:id" "$STATUS" "200"

# 404 test
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/nonexistent")
check "GET /api/projects/nonexistent → 404" "$STATUS" "404"

# Summary
echo ""
echo "================================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 All tests passed!"
else
  echo "⚠️  Some tests failed"
  exit 1
fi
echo ""
