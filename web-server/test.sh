#!/bin/bash
# Quick integration test for the Storyboarder web server
# Usage: Start server first (node server.js), then run: bash test.sh

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
echo "🧪 Storyboarder Web Server — Integration Tests"
echo "================================================"

# Health check
echo ""
echo "── Health ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")
check "GET /api/health" "$STATUS" "200"

# App info
echo ""
echo "── App ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/app/version")
check "GET /api/app/version" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/app/path/userData")
check "GET /api/app/path/userData" "$STATUS" "200"

# Preferences
echo ""
echo "── Prefs ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/prefs")
check "GET /api/prefs" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" \
  -d '{"enableAutoSave": false}' "$BASE/api/prefs")
check "PUT /api/prefs" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/prefs/enableAutoSave")
check "GET /api/prefs/enableAutoSave" "$STATUS" "200"

# Projects
echo ""
echo "── Projects ──"

# Create project
RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"aspectRatio": 1.7777, "fps": 24}' "$BASE/api/projects")
STATUS=$(echo "$RESPONSE" | grep -o '"id"' | head -1)
PROJECT_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$PROJECT_ID" ]; then
  echo "  ✅ POST /api/projects → id: $PROJECT_ID"
  ((PASS++))
else
  echo "  ❌ POST /api/projects — no ID returned"
  echo "     Response: $RESPONSE"
  ((FAIL++))
fi

# List projects
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects")
check "GET /api/projects" "$STATUS" "200"

# Get project
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$PROJECT_ID")
check "GET /api/projects/:id" "$STATUS" "200"

# Update project
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" \
  -d '{"fps": 30}' "$BASE/api/projects/$PROJECT_ID")
check "PUT /api/projects/:id" "$STATUS" "200"

# Boards
echo ""
echo "── Boards ──"

# Add board
BOARD_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"dialogue": "Hello world", "action": "Character walks in", "notes": "Wide shot"}' \
  "$BASE/api/projects/$PROJECT_ID/boards")
BOARD_UID=$(echo "$BOARD_RESPONSE" | grep -o '"uid":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$BOARD_UID" ]; then
  echo "  ✅ POST /api/projects/:id/boards → uid: $BOARD_UID"
  ((PASS++))
else
  echo "  ❌ POST /api/projects/:id/boards — no UID returned"
  echo "     Response: $BOARD_RESPONSE"
  ((FAIL++))
fi

# Add second board
BOARD2_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"dialogue": "Second board", "action": "Cut to close-up"}' \
  "$BASE/api/projects/$PROJECT_ID/boards")
BOARD2_UID=$(echo "$BOARD2_RESPONSE" | grep -o '"uid":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$BOARD2_UID" ]; then
  echo "  ✅ POST /api/projects/:id/boards (2nd) → uid: $BOARD2_UID"
  ((PASS++))
else
  echo "  ❌ POST /api/projects/:id/boards (2nd) — no UID"
  ((FAIL++))
fi

# List boards
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$PROJECT_ID/boards")
check "GET /api/projects/:id/boards" "$STATUS" "200"

# Update board
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" \
  -d '{"dialogue": "Updated dialogue"}' "$BASE/api/projects/$PROJECT_ID/boards/$BOARD_UID")
check "PUT /api/projects/:id/boards/:uid" "$STATUS" "200"

# Reorder boards
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" \
  -d "{\"order\": [\"$BOARD2_UID\", \"$BOARD_UID\"]}" "$BASE/api/projects/$PROJECT_ID/boards/reorder")
check "PUT /api/projects/:id/boards/reorder" "$STATUS" "200"

# Verify full project
FULL=$(curl -s "$BASE/api/projects/$PROJECT_ID")
BOARD_COUNT=$(echo "$FULL" | grep -o '"uid"' | wc -l)
echo "  ℹ️  Project has $BOARD_COUNT boards"

# Agent API
echo ""
echo "── Agent ──"

# Create project via agent
AGENT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"title": "Agent Test", "boards": [{"dialogue": "Agent board 1"}, {"dialogue": "Agent board 2"}]}' \
  "$BASE/api/agent/create-project")
AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$AGENT_ID" ]; then
  echo "  ✅ POST /api/agent/create-project → id: $AGENT_ID"
  ((PASS++))
else
  echo "  ❌ POST /api/agent/create-project — no ID"
  ((FAIL++))
fi

# Share URL
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/agent/share/$AGENT_ID")
check "GET /api/agent/share/:id" "$STATUS" "200"

# Images
echo ""
echo "── Files/Images ──"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$PROJECT_ID/images")
check "GET /api/projects/:id/images" "$STATUS" "200"

# Export
echo ""
echo "── Export ──"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PROJECT_ID/export/images")
check "POST /api/projects/:id/export/images" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PROJECT_ID/export/zip")
check "POST /api/projects/:id/export/zip" "$STATUS" "200"

# Cleanup — delete boards
echo ""
echo "── Cleanup ──"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/projects/$PROJECT_ID/boards/$BOARD_UID")
check "DELETE /api/projects/:id/boards/:uid" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/projects/$PROJECT_ID")
check "DELETE /api/projects/:id" "$STATUS" "200"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/projects/$AGENT_ID")
check "DELETE /api/projects/:id (agent)" "$STATUS" "200"

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
