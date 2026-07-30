---
name: Django Shell
description: A calm, dense, native VS Code workbench for operating a live Django shell.
colors:
  editor-surface: "var(--vscode-editor-background)"
  workbench-surface: "var(--vscode-editorGroupHeader-tabsBackground)"
  widget-surface: "var(--vscode-editorWidget-background)"
  primary-text: "var(--vscode-foreground)"
  secondary-text: "var(--vscode-descriptionForeground)"
  structural-border: "var(--vscode-panel-border)"
  focus-ring: "var(--vscode-focusBorder)"
  action-fill: "var(--vscode-button-background)"
  action-text: "var(--vscode-button-foreground)"
  secondary-action-fill: "var(--vscode-button-secondaryBackground)"
  hover-fill: "var(--vscode-list-hoverBackground)"
  selected-fill: "var(--vscode-list-activeSelectionBackground)"
  selected-text: "var(--vscode-list-activeSelectionForeground)"
  error-text: "var(--vscode-errorForeground)"
  warning-surface: "var(--vscode-inputValidation-warningBackground)"
  warning-border: "var(--vscode-inputValidation-warningBorder)"
typography:
  title:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "var(--vscode-font-size)"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.35
  code:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "var(--vscode-editor-font-size)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  square: "0"
  edit: "2px"
  control: "4px"
  floating: "6px"
  pill: "999px"
spacing:
  hairline: "1px"
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
components:
  button-primary:
    backgroundColor: "{colors.action-fill}"
    textColor: "{colors.action-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "3px 9px"
  button-secondary:
    backgroundColor: "{colors.secondary-action-fill}"
    textColor: "{colors.primary-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "3px 9px"
  input:
    backgroundColor: "{colors.editor-surface}"
    textColor: "{colors.primary-text}"
    typography: "{typography.body}"
    rounded: "{rounded.edit}"
    padding: "3px 6px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    size: "24px"
  filter-chip:
    backgroundColor: "{colors.workbench-surface}"
    textColor: "{colors.primary-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
  data-cell:
    backgroundColor: "{colors.editor-surface}"
    textColor: "{colors.primary-text}"
    typography: "{typography.code}"
    rounded: "{rounded.square}"
    padding: "3px 8px"
---

# Design System: Django Shell

## Overview

**Creative North Star: "The Live Django Workbench"**

Django Shell should feel like a precise instrument built into VS Code, not a separate web application placed inside it. The visual system is calm, compact, and operational: it makes the live shell, current model, transport, execution state, staged changes, and recovery actions easy to scan without competing with the developer's code.

Density is deliberate because the primary users are experienced Django developers working with large namespaces and wide schemas. That density must remain ordered rather than cramped. Stable regions, consistent alignment, semantic hierarchy, and progressive disclosure carry the complexity; decoration does not.

The extension inherits its identity from the active VS Code theme. It does not introduce a fixed brand palette, custom typeface, card-heavy dashboard language, oversized headings, gradients, or consumer-product illustration. Color is reserved for platform-defined actions, focus, selection, validation, and status.

**Key Characteristics:**

- Native to the current VS Code theme and interaction vocabulary.
- Dense, keyboard-efficient, and optimized for expert scanning.
- Stable under long-running, remote, empty, error, and partially loaded states.
- Explicit about execution context, transport, staged edits, and destructive boundaries.
- Flat and structural, using borders and tonal surfaces before shadows.
- Responsive to editor-group width rather than assuming a full-window page.

## Colors

All visible colors come from semantic VS Code theme variables so dark, light, and high-contrast themes remain authoritative.

### Primary

- **Workbench Action:** The platform button background and foreground pair is used for the single primary action in the current context, such as Run or Commit.
- **Focus Signal:** The platform focus border identifies keyboard focus, active field targeting, and the current grid position.

### Neutral

- **Editor Plane:** The editor background is the main working surface for console output, query editing, and model rows.
- **Workbench Plane:** The editor-group header surface distinguishes toolbars, sticky grid headers, and bounded control bands.
- **Widget Plane:** The editor-widget surface is reserved for transient floating UI such as combobox lists, field finders, and modal editors.
- **Primary Text:** The normal foreground carries labels and data.
- **Secondary Text:** The description foreground carries metadata, type hints, counts, timestamps, and supporting copy.
- **Structural Border:** The panel border separates stable regions and grid cells without adding unnecessary depth.

### State

- **Selection:** Active selection variables represent chosen rows, list items, and keyboard-active options.
- **Warning:** Input-validation warning variables identify staged but uncommitted cells and their commit summary.
- **Error:** The platform error foreground and input-validation variables identify failed operations and invalid values.

### Named Rules

**The Theme Is the Brand Rule.** Never replace semantic VS Code color variables with a fixed product palette in a user-visible surface.

**The State Before Accent Rule.** Use accent color only to communicate an action, focus, selection, validation, or status; never as ambient decoration.

**The Text Plus Signal Rule.** Connection, execution, warning, and error states always include readable text or an accessible name and never rely on color alone.

## Typography

**Display Font:** Not used.

**Body Font:** The active VS Code UI font.

**Label/Mono Font:** The active VS Code editor font for Python, SQL, model values, field paths, and numeric data.

**Character:** Typography is quiet and platform-native. Hierarchy comes from modest weight, size, alignment, and spacing changes rather than large jumps in scale.

### Hierarchy

- **Title** (600, 13px, 1.4): Surface identity, current model, and compact section titles.
- **Body** (400, active VS Code UI size, 1.4): Buttons, controls, tree rows, instructions, and normal UI copy.
- **Label** (400, 11px, 1.35): Field types, transport detail, counts, timestamps, and secondary state.
- **Code** (400, active VS Code editor size, 1.45): Python, SQL, scalar values, query results, and editable model data.

### Named Rules

**The Code Is Data Rule.** Python, SQL, field paths, values, and results use the editor font; control labels and explanatory text use the UI font.

**The No Hero Type Rule.** No active extension surface uses marketing-scale typography. A user should see more useful state, not a larger heading, when space increases.

## Layout

The base rhythm uses small increments from the existing 2–16px spacing vocabulary. One-pixel borders define regions. Primary toolbars are 28–34px high where platform controls permit. Content is aligned to an 8px rhythm with 4–6px internal gaps for dense control groups.

Every editor webview follows a stable band model:

1. An identity and runtime-status band.
2. A task-control band containing the current context and primary action.
3. A flexible work area.
4. An optional footer for counts, pagination, and staged-change actions.
5. Secondary information, such as query history, in a collapsible drawer.

Responsive behavior is based on the webview's available width:

- **Wide, 960px and above:** Show full labels, context, status, and primary plus secondary actions in one line where possible.
- **Medium, 640–959px:** Preserve the context and primary action; move secondary actions into a labeled overflow menu and allow control bands to wrap to a deliberate second row.
- **Narrow, below 640px:** Use two-row headers, short labels, and drawers for filters, field selection, and query history. Never clip controls or hide execution, dirty, error, or transport state.

Sidebars are designed independently for widths from 200–360px. Long application, model, variable, frame, and field names truncate visually with a tooltip or accessible description while preserving the full value for assistive technology.

Grid density is high, but rendered content is bounded. The data grid virtualizes both rows and columns, keeps row number and explicitly pinned fields stable, and exposes total row and column counts semantically. Aggregate and nested result tables may remain non-virtual only when their size is explicitly bounded.

### Named Rules

**The Workbench Geometry Rule.** Layout decisions respond to editor-group and sidebar width, not the overall VS Code window width.

**The Context Never Disappears Rule.** Narrow layouts may shorten or move controls, but the active model or query, runtime state, primary action, transport, dirty state, and failure state remain available.

**The Bounded DOM Rule.** A large Django schema must not produce a DOM or accessibility tree proportional to every row multiplied by every column.

## Elevation & Depth

The system is flat by default. Editor, toolbar, footer, and drawer planes are separated with platform surfaces and one-pixel borders. Shadows are reserved for UI that physically overlays the working plane: combobox menus, field finders, tooltips, and modal array editors. Shadows never create a card grid or imply hierarchy that does not exist.

### Shadow Vocabulary

- **Floating Widget:** A compact platform-like shadow beneath combobox menus and field finders.
- **Modal Editor:** A stronger shadow beneath the array editor or another blocking transient surface.

### Named Rules

**The Quiet Plane Rule.** Persistent regions use tonal surfaces and borders; only transient overlapping regions cast shadows.

## Shapes

Controls use compact 2–4px radii. Floating widgets and modal editors may use 6px. Pills are reserved for removable filters, compact statuses, and bounded tags. Grid cells, persistent bands, and major containers remain square so the extension aligns with VS Code's workbench geometry.

Borders communicate structure, focus, and validation. Decorative outlines, oversized rounded cards, and nested card-on-card compositions are not part of the system.

## Components

### Buttons

- **Shape:** Compact platform controls with a 4px radius and a minimum 24px hit box.
- **Primary:** Use the platform primary button colors for exactly one current-context action.
- **Secondary:** Use the platform secondary button colors or a transparent icon treatment.
- **Hover / Focus:** Use the platform hover variable and a visible focus ring. Focus must remain visible in high-contrast themes.
- **Loading:** Keep the label stable where possible, disable duplicate submission, add adjacent running state, and expose Cancel or Interrupt when the operation can outlive a normal request.
- **Disabled:** Use native disabled semantics and platform disabled color; a disabled control must not look selected or primary.
- **Icon-only:** Use Codicons, an accessible name, a tooltip, and a 24px target. Decorative icon spans are hidden from assistive technology.

### Inputs / Fields

- **Style:** Platform input background, foreground, border, and compact 2–4px radius.
- **Label:** Every input has a persistent visible label or a programmatic accessible name; placeholder text is never the sole label.
- **Focus:** Use the platform focus border without removing the browser focus affordance unless an equivalent is present.
- **Error:** Associate concise inline error text with the control and announce asynchronous validation failures.
- **Disabled / Read-only:** Distinguish disabled, read-only, and busy states semantically and visually.

### Chips

- **Style:** Pills are used for active filters, selected conditions, and compact state metadata.
- **State:** Selected and removable states include text plus a Codicon action; the remove action has an accessible name containing the chip label.
- **Overflow:** Chip rows wrap in control regions or scroll deliberately in bounded data-detail regions.

### Lists and Tree Rows

- **Style:** Rows use platform list hover and active-selection colors with compact vertical padding.
- **Interaction:** Interactive rows are semantic buttons or tree items and support Enter, Space, arrows where applicable, Home, and End.
- **Hierarchy:** Expandable groups expose expanded state and item counts. Icons are Codicons and do not replace text.
- **Empty / Error:** Loading, empty, stale, and error states occupy the same region as the list and offer an applicable recovery action.

### Data Grid

- **Structure:** A virtualized ARIA grid with a sticky header, row-number gutter, optional pinned fields, and bounded visible cells.
- **Navigation:** One roving tab stop enters the grid. Arrow keys move cells; Home and End move within a row; Ctrl/Cmd+Home and Ctrl/Cmd+End move to grid bounds; Enter or F2 starts an editable cell; Escape cancels editing.
- **Sorting:** Sort headers are buttons with `aria-sort`. Sort order is communicated by text or accessible name as well as an icon.
- **Editing:** Dirty cells use warning surface and border plus an accessible dirty description. Saving happens only from the explicit Commit action.
- **Loading / Empty / Error:** The grid keeps its header and context stable, uses a status region for progress, and provides Retry after failure.
- **Query-result continuity:** Applying a query never clears previously loaded rows until the matching Recipe revision succeeds. A rejected or stale response keeps the prior grid and directs attention to the query issue summary instead.
- **Performance:** Visible rows and columns are windowed while semantic row and column counts describe the full dataset.

### Status Strip

- **Style:** Compact text, Codicon, and optional elapsed time in a stable region.
- **States:** Starting, ready, running, cancelling, disconnected, succeeded, failed, timed out, dirty, and read-only each have fixed language.
- **Announcements:** Significant asynchronous transitions use a polite live region; destructive failures use an alert.

### Drawers and Floating Widgets

- **Query Log:** Collapsed by default for a new panel, remembers the user's last explicit state, and opens as a bounded lower drawer.
- **Query Builder:** Model Data always shows a compact summary band with filter count, computed-column count, result mode, human summary, draft state, validation state, and the one Apply action. Its bounded drawer holds WHERE, computed columns, result filter, result settings, and ORM preview/validation in that order. The drawer uses semantic section labels, retains the draft when closed, and keeps actions reachable at narrow editor widths.
- **Draft and applied state:** Editing changes only the draft. Reset restores the applied Recipe and Clear creates an empty draft; neither executes a query. Apply runs a revisioned snapshot. If the user edits during execution, the newer draft remains marked `Draft` while the grid reflects the successful snapshot.
- **AI Assist:** The existing Query Builder review inspector has a fourth, subordinate AI Assist tab in Operate mode—not a modal, stage, or hero surface. It shows privacy disclosure, Provider, Provider settings, Model, Reasoning, Instructions, generation/review actions, Refresh models, and Open settings in that order. Model is one authoritative select: `Automatic — provider default/latest` re-enables provider defaults while retaining a manual pin, and a concrete model saves that pin with automatic mode off. The user selects a local provider and instruction, may cancel a buffered request, and sees an AI-generated proposal through local meaning, warnings, and ORM while the host revalidates and adds the fresh suggestion to the draft automatically. The unchanged accepted draft is labeled `AI 조립`; any later draft or source change clears it. That action schedules the usual preview; **Apply query** remains a separate manual action.
- **Assistant states and privacy:** Detecting, unavailable, metadata-unavailable, empty, ready, unverified, incompatible, running, cancelling, invalid/error, suggestion, stale, and accepted states use visible labels and text-plus-state signals. Automatic model updates omit `--model`, follow the selected provider CLI's effective default/latest model, and retain rather than clear the manual pin; empty reasoning uses the provider CLI default and omits its override. The selected CLI receives instructions, current draft including literal values, and model schema; row data is excluded. Claude Code has tools and session persistence disabled; Codex is read-only and ephemeral in the current workspace; discovery uses only local CLI help/catalog commands. Assistant content never streams partial JSON, remains visibly AI-generated, and scrolls within the existing review pane on narrow layouts.
- **Assistant visual boundary:** Use dense VS Code tokens, existing UI/editor fonts, flat one-border sections, labels above controls, and the existing mobile Edit/Review switch. Do not add an AI palette, glow, gradient, glass, decorative animation, or a parallel hierarchy.
- **Validation and error:** Validation uses text plus a state signal (`Valid`, error count, warning count, or `Checking…`). Errors appear both beside the affected builder node and in a focusable summary; selecting a summary issue opens the drawer and targets the first invalid control. Warnings never use color alone and do not block Apply.
- **Combobox / Field Finder:** Uses semantic combobox, listbox, and option roles with complete keyboard interaction and focus return.
- **Resizable Sash:** Uses a focusable separator with orientation and keyboard increments, not pointer-only dragging.

### Native VS Code Trees

- **Runtime Inspector:** Uses native `TreeItem`, `ThemeIcon`, description, tooltip, collapsible state, and view-title actions. Loading, unavailable transport, empty runtime, and error are distinct.
- **Debug Analysis:** Uses native groups for paused frame, trace, stack, and variables. The idle state includes an actionable start-debug command instead of passive instruction alone.

## Do's and Don'ts

### Do:

- **Do** inherit every surface, text, border, focus, action, selection, warning, and error color from semantic VS Code variables.
- **Do** keep live execution context, transport, progress, dirty state, and recovery actions visible.
- **Do** use Codicons and semantic platform controls before creating a custom icon or interaction.
- **Do** provide keyboard operation, visible focus, accessible names, and live status announcements for every workflow.
- **Do** design and verify wide, split-editor, narrow-sidebar, dark, light, high-contrast, and 200% zoom states.
- **Do** keep the model grid's rendered DOM and accessibility tree bounded for wide real-world schemas.
- **Do** separate functional verification from rendered visual verification.

### Don't:

- **Don't** introduce a fixed brand palette, custom font, gradient, illustration, oversized heading, glass effect, or card-dashboard motif.
- **Don't** use color, a dot, an arrow glyph, or placeholder text as the only meaning-bearing signal.
- **Don't** hide the active model, query, runtime state, primary action, transport, staged-change count, or error recovery to make a narrow layout look cleaner.
- **Don't** leave long-running operations without duplicate-submit prevention, elapsed status, timeout behavior, and an Interrupt or Cancel path.
- **Don't** render every row multiplied by every field for a wide Django model.
- **Don't** make resizing, sorting, expanding, selecting, or opening a model dependent on a pointer.
- **Don't** imply that a staged model edit has been saved before an explicit successful Commit response.
