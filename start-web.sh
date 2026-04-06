#!/bin/bash
# Start the Storyboarder web app
set -e

cd "$(dirname "$0")"

echo "🎬 Starting Storyboarder Web..."

# Check if web bundle exists
if [ ! -f "src/build/web-app.js" ]; then
  echo "⚠️  Web bundle not found at src/build/web-app.js"
  echo "   Run: npm run build:web"
  echo "   Starting server anyway (API will work, but UI won't load)"
fi

# Install server deps if needed
if [ ! -d "web-server/node_modules" ]; then
  echo "📦 Installing server dependencies..."
  cd web-server && npm install && cd ..
fi

# Start the server
echo ""
exec node web-server/server.js
