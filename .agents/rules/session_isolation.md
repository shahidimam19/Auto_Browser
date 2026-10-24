# Session Isolation Rule

- All code, scripts, HTML snapshots, JSON outputs, CSVs, and Excel sheets generated for or associated with any specific recording session MUST be located inside that session's folder:
  `recordings/<session_id>/analyse/`
- Never write session-specific artifacts or scripts to the project root.
- The project root is reserved solely for the core Auto_Browser application (`main.js`, `recorder.js`, `preload.js`, `settings.json`, `templates/`, `ui/`, etc.).
