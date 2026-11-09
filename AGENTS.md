# Auto_Browser Agent Guidelines & Workspace Rules

## 1. Strict Separation Between Browser Core Code and Session Data
- **Core Browser Code**: Keep root directory and core app modules (`src/` containing `main.js`, `recorder.js`, `preload.js`, `interaction.js`, plus `settings.json`, `smoke_test.js`, `templates/`, `ui/`) strictly for the Auto_Browser Electron application.
- **NEVER** write session-specific scraping scripts, HTML dumps, CSV exports, Excel spreadsheets, or analysis code in the project root.

## 2. Session & Task Isolation Rule
- **All code and files related to any recording session or task MUST strictly reside inside that folder:**
  `recordings/<session_id>/analyse/` (or `recordings/<session_id>/`) and `tasks/<task_name>/analyse/` (or `tasks/<task_name>/`).
- **Discussion & Task Execution**:
  Whenever discussing, inspecting, analyzing, scraping, or processing data from a specific recording session or saved task:
  1. All session/task-related scripts (e.g. Node.js scripts, Python scrapers, parser scripts) must be created and executed inside `tasks/<task_name>/analyse/` (or `recordings/<session_id>/analyse/`).
  2. All generated output files (e.g., `.html`, `.json`, `.csv`, `.xlsx`, `.md`, `.pdf`) must be written directly into that folder.
  3. Working directory for running any session- or task-specific analysis or export must be targeted within that folder.
