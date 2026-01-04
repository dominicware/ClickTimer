# ClickTimer Chrome Extension

## What This Does
Turns time values in recipe pages into clickable timers.

## Installation
1. Open Chrome
2. Go to chrome://extensions
3. Enable Developer Mode
4. Load unpacked → select project folder

## Project Structure
- manifest.json — Chrome extension config
- content.js — Injects timer logic into pages

## How It Works
- Scans DOM for time strings
- Wraps them in clickable spans
