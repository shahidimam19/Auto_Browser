# Auto_Browser Agent Guidelines & Workspace Rules

## 1. Strict Separation Between Browser Core Code and Session Data
- **Core Browser Code**: Keep root directory and core app modules (`main.js`, `recorder.js`, `preload.js`, `settings.json`, `smoke_test.js`, `templates/`, `ui/`) strictly for the Auto_Browser Electron application.
- **NEVER** write session-specific scraping scripts, HTML dumps, CSV exports, Excel spreadsheets, or analysis code in the project root.

## 2. Session Isolation Rule
- **All code and files related to any recording session MUST strictly reside inside that session's folder:**
  `recordings/<session_id>/analyse/` (or `recordings/<session_id>/`).
- **Discussion & Task Execution**:
  Whenever discussing, inspecting, analyzing, scraping, or processing data from a specific recording session:
  1. All session-related scripts (e.g. Node.js scripts, Python scrapers, parser scripts) must be created and executed inside `recordings/<session_id>/analyse/`.
  2. All generated output files (e.g., `.html`, `.json`, `.csv`, `.xlsx`, `.md`) must be written directly into `recordings/<session_id>/analyse/`.
  3. Working directory for running any session-specific analysis or export must be targeted within that session folder.
