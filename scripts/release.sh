#!/bin/bash

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Get current version from tauri.conf.json
CURRENT_VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')

echo -e "${BLUE}Current version: ${GREEN}${CURRENT_VERSION}${NC}"
echo ""

# Get new version from argument or prompt
if [ -z "$1" ]; then
    echo -e "${YELLOW}Enter new version (e.g., 0.1.2):${NC}"
    read -r NEW_VERSION
else
    NEW_VERSION="$1"
fi

if [ -z "$NEW_VERSION" ]; then
    echo "Error: No version provided"
    exit 1
fi

echo -e "${BLUE}Updating to version: ${GREEN}${NEW_VERSION}${NC}"
echo ""

# Update package.json
echo "Updating package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" package.json

# Update tauri.conf.json
echo "Updating src-tauri/tauri.conf.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" src-tauri/tauri.conf.json

# Update Cargo.toml
echo "Updating src-tauri/Cargo.toml..."
sed -i '' "s/^version = \"[^\"]*\"/version = \"${NEW_VERSION}\"/" src-tauri/Cargo.toml

echo ""
echo -e "${GREEN}✓ Version files updated${NC}"

# Show updated versions
echo ""
echo -e "${BLUE}Verification:${NC}"
echo "  package.json:       $(grep '"version"' package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
echo "  tauri.conf.json:    $(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
echo "  Cargo.toml:         $(grep '^version' src-tauri/Cargo.toml | sed 's/.*"\([^"]*\)".*/\1/')"

echo ""
echo -e "${BLUE}Staging changes...${NC}"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml

echo -e "${BLUE}Committing...${NC}"
git commit -m "chore: bump version to ${NEW_VERSION}"

echo -e "${BLUE}Tagging as v${NEW_VERSION}...${NC}"
git tag "v${NEW_VERSION}"

echo ""
echo -e "${YELLOW}Ready to push. Run:${NC}"
echo "  git push origin master"
echo "  git push origin v${NEW_VERSION}"
echo ""
echo -e "${YELLOW}Or to push everything at once:${NC}"
echo "  git push origin master --tags"
echo ""
read -p "Push now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git push origin master --tags
    echo -e "${GREEN}✓ Pushed to origin${NC}"
fi
