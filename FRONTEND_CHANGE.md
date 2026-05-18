# Frontend Change Note

The primary Django Shell frontend is moving from the VS Code Notebook UI to a custom webview UI.

The notebook implementation remains in the repository for compatibility with existing `.djshell` files, but it is deprecated. New frontend work should target `CustomDjangoConsole` and reuse the existing Python backend bridge instead of adding more notebook cell, shadow file, or serializer behavior.

Current direction:

- Primary UI: `djangoShell.openConsole`
- Python cell: workbench overlay editor via `djangoShell.showOverlayEditor`, without creating disk-backed `*.py` cell files
- Deprecated UI: `djangoShell.openNotebookConsoleDeprecated`
- Backend reuse: `NotebookPtySession` starts the shell and attaches `django_shell_backend.py`
- Runtime view: `RuntimeInspector` reads from the custom console backend
- Notebook code: retained only as compatibility surface
