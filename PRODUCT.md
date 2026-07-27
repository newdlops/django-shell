# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are experienced Django backend developers working in VS Code. They use the extension while actively developing, debugging, and inspecting a real Django project and expect expert-oriented density, keyboard efficiency, and trustworthy system feedback rather than tutorial-led workflows.

## Product Purpose

Django Shell lets developers execute Python, debug runtime behavior, inspect live values, browse and edit model data, and run ORM queries from VS Code without leaving the real `manage.py shell` process.

Success means a developer can move quickly between code, live runtime state, and database-backed model data while always understanding what will execute, where it will execute, which transport is active, and whether an operation is read-only, staged, running, successful, or failed.

## Positioning

The product does not emulate a Django shell, spawn a separate analysis environment, or rely only on static parsing. Its defining mechanism is that the console, runtime inspection, debugger, model browser, and ORM query tools communicate with the same in-process backend and live namespace held by the user's actual shell session.

## Operating Context

- The product runs as a VS Code extension inside a Django workspace that contains `manage.py`.
- A normal session begins by opening the custom console, starting `manage.py shell` or `shell_plus` in the setup terminal, and waiting for the backend to attach.
- Users move among the custom console, workbench overlay editor, Models catalog, model data grid, ORM query console, Runtime Inspector, and Debug Analysis surfaces.
- Work may run locally or through remote SSH, kubectl, or other terminal-backed environments.
- Socket, terminal, automatic, and ORM transports have materially different capabilities and failure modes that the UI must communicate accurately.
- Database edits are staged locally in a grid and are not sent until the user explicitly commits them.

## Capabilities and Constraints

- Preserve the current commands, keyboard semantics, execution model, transport behavior, debugging behavior, and data-safety guarantees unless a later task explicitly changes them.
- Treat the custom console as the primary shell experience; the notebook console is deprecated and is not a redesign target except where its presence affects navigation or migration messaging.
- Cover the entire active user-visible interface: custom console, overlay editor, Models catalog, model data browser, ORM query console, Runtime Inspector, and Debug Analysis.
- Preserve integration with VS Code themes, high-contrast modes, Codicons, workbench layout, panels, webviews, tree views, editor overlays, command palette, and context-sensitive title actions.
- Keep expert workflows compact and fast. Do not simplify the interface by hiding essential query, transport, execution, debugging, or data-integrity information.
- Model-browser reads are bounded. Edits are validated and committed transactionally. The redesign must never imply that a staged value has already been saved.
- The interface must remain viable in narrow sidebars, ordinary editor panels, split editor layouts, dense tables, long model and field names, large runtime values, and slower remote transports.

## Brand Commitments

- Preserve the product name “Django Shell.”
- Preserve the existing Django/Python/VS Code developer-tool context rather than introducing a separate consumer-product visual language.
- Use VS Code's native interaction vocabulary and theme tokens as the primary visual authority.
- Retain the existing product icons unless a later implementation task explicitly includes icon refinement.

## Evidence on Hand

- Product capabilities, commands, setup, safety model, and development workflow: `README.md`
- Extension contributions, commands, views, menus, settings, and VS Code platform constraints: `package.json`
- Current webview markup and styles: `src/customConsoleHtml.ts`, `src/modelCatalogHtml.ts`, and `src/modelBrowserHtml.ts`
- Current webview interaction implementations: `media/customConsoleSource.js`, `media/modelCatalogSource.js`, `media/modelBrowserSource.js`, and `media/grid*.js`
- Native VS Code tree and editor-overlay surfaces: `src/runtimeInspector.ts`, `src/debugAnalysisPanel.ts`, and `src/workbenchOverlay*.ts`
- Product icons and Codicon integration: `media/django-shell.svg`, `media/icon.svg`, `media/icon.png`, `media/python.svg`, and `media/codicon.css`
- No external research, customer testimonials, usage analytics, formal usability study, Figma file, or established design document is currently present in the repository. Future work must not fabricate such evidence.

## Product Principles

1. Keep the real execution context visible: users should always know which shell, transport, model, query, or debug state they are operating on.
2. Make expert work faster without making destructive work casual: optimize scanability and keyboard flow while keeping staging, validation, commit, and error boundaries unmistakable.
3. Use progressive disclosure for advanced power, not for essential state: advanced query assembly (nested predicates, computed columns, subqueries, and summaries), complex filters, aggregates, and related data can expand on demand, but connection, execution, dirty, and failure states stay visible.
4. Behave like a first-class part of VS Code: respect themes, density, focus behavior, command conventions, workbench geometry, and narrow layouts.
5. Preserve trust under latency and failure: every asynchronous operation needs a stable pending state, a useful result or error, and a clear recovery action.

## Accessibility & Inclusion

Keyboard-only operation, visible focus, theme compatibility, high-contrast compatibility, zoom resilience, non-color-only state communication, and accessible names for icon controls are required across redesigned webviews. A formal conformance certification target has not been established.
