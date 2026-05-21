# Django Shell

Django Shell is a VS Code extension for working inside a real Django shell with a notebook-like custom console, a Python editor overlay, and a runtime inspector.

The primary UI is `Django Shell: Open Console`. The older `.djshell` notebook frontend is still available for compatibility, but it is deprecated.

## Features

- Opens an embedded setup terminal in the workspace root.
- Attaches to `python manage.py shell` and `python manage.py shell_plus` sessions.
- Provides a Python input editor after the Django shell backend is ready.
- Runs Python code in the live Django shell namespace and shows stdout, stderr, expression results, and tracebacks.
- Reuses VS Code Python/Pylance features through generated analysis files under `.django-shell/`.
- Keeps generated runtime preludes hidden from the user-facing editor.
- Refreshes runtime imports after executed code so dynamic variables can participate in analysis.
- Shows runtime variables, modules, nested object children, dataclass fields, inherited class attributes, and properties in the Django Shell Runtime view.
- Clears stale editor input, generated preludes, and runtime state on Restart Kernel.

## Requirements

- VS Code 1.92 or newer.
- The Microsoft Python extension.
- Pylance.
- A Django project that can start an interactive shell from the workspace root.

For typical projects, open the folder that contains `manage.py`, then run the console command.

## Quick Start

1. Open a Django project folder in VS Code.
2. Run `Django Shell: Open Console` from the Command Palette.
3. In the setup terminal, start Django shell, for example:

   ```sh
   python manage.py shell
   ```

4. Wait until the Python input cell is enabled.
5. Click the Python editor area and run code with Enter or the run command.

The console runs code in the same live namespace as the attached shell process.

## Commands

| Command | Purpose |
| --- | --- |
| `Django Shell: Open Console` | Opens the primary custom console. |
| `Django Shell: Show Overlay Editor` | Shows the workbench-hosted Python overlay editor. |
| `Django Shell: Run Current Python Input` | Runs the current logical Python input block from the overlay. |
| `Django Shell: Open Notebook Console (Deprecated)` | Opens the legacy `.djshell` notebook console. |
| `Django Shell: Refresh Runtime Inspector` | Refreshes the runtime tree view. |
| `Django Shell: Show Process Environment` | Shows the attached process environment details. |

## Keybindings

In the overlay editor:

| Key | Action |
| --- | --- |
| Enter | Run the current Python input when completion and parameter widgets are not active. |
| Shift+Enter | Insert a newline. |
| Ctrl+Enter / Cmd+Enter | Run the current Python input. |

## Runtime Inspector

The Django Shell activity bar view exposes the active runtime namespace.

It can show:

- User variables and importable initial shell values.
- Loaded Python modules.
- Nested collection items.
- Object attributes from safe dictionaries.
- Inherited class attributes.
- Dataclass fields, including `slots=True` dataclasses.
- Property names and values when a user explicitly expands an object.

Top-level inspection avoids evaluating properties. Property getters can execute arbitrary Python, so they are only read during explicit child inspection.

Runtime inspection needs the backend socket bridge. If the active environment only supports terminal fallback transport, the view reports that remote runtime inspection is disabled.

## IntelliSense Model

The extension creates generated Python files in `.django-shell/` to let Python language features work against Django shell input:

- `console-cell.py` stores provider-only runtime/source preludes plus user input; the Python cell view shows only user input.

The extension overwrites these files as implementation details. They should not be edited or committed.

Runtime and source preludes are intentionally separated from visible input so generated imports do not appear while typing or accepting autocomplete suggestions.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `djangoShell.autoActivateWorkspaceVenv` | `true` | Prepends `.venv` or `venv` to the setup terminal environment when present. |
| `djangoShell.enableCodeActions` | `false` | Forwards code actions through generated Python shadow documents. This can be expensive in large projects. |
| `djangoShell.enableModelPreludeImports` | `false` | Scans workspace model files and imports discovered model classes into editor preludes. This can be expensive in large projects. |
| `djangoShell.enableRuntimeCompletion` | `false` | Enables deprecated notebook-cell runtime variable completions. |
| `djangoShell.diagnosticLogging` | `false` | Writes runtime, source analysis, and editor bridge diagnostics to the `Django Shell` output channel. |

## Deprecated Notebook Console

`.djshell` notebooks and `Django Shell: Open Notebook Console (Deprecated)` are retained for existing users. New work should use `Django Shell: Open Console`.

## Troubleshooting

If the Python input cell stays disabled, confirm that the setup terminal has entered an interactive Django shell prompt.

If IntelliSense looks stale, run Restart Kernel from the console header. This clears the overlay document, analysis prelude, and runtime cache.

If the runtime inspector is unavailable in a remote setup, the backend socket bridge may not be reachable from the extension host. Code execution through the terminal fallback can still work, but runtime tree inspection is disabled in that mode.

If the terminal fails to start after installing a VSIX, rebuild or package the extension on the target platform. The extension uses the native `node-pty` dependency.

## Development

Install dependencies and run checks from the repository root:

```sh
npm install
npm run check
```

Run extension-host E2E tests:

```sh
npm run test:e2e
```

Build a VSIX:

```sh
npm run package
```

The package is filtered by `.vscodeignore` so source files, tests, logs, generated indexes, source maps, Python caches, and native debug symbols are excluded.

## License

This extension is proprietary software. See [LICENSE](LICENSE).
