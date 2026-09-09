# Deployment Guide

This document describes how to package and release the Django Shell VS Code extension.

## Current Release State

The extension is published as `newdlops.django-shell`. Keep `package.json` and the root package entries in `package-lock.json` on the same release version, and add the user-visible changes to `CHANGELOG.md`.

The existing `UNLICENSED` manifest and proprietary `LICENSE` describe the current distribution terms. Keep `icon: media/icon.png` as the 128x128 Marketplace icon.

The activity bar icon remains `media/django-shell.svg`. Do not use the colored deployment icon there because VS Code activity icons are expected to be theme-colored SVGs.

### 1.1.1000055 validation record — 2026-09-09

- `npm run check`: 1,035 tests passed with no failures or skips, including multi-hop relationship metadata resolution, real Django lookup execution, and searchable field-path validation.
- Browser fixture checks passed at 390, 768, and 1440 pixels wide: relationship traversal and pasted lookups, nested AND/OR, duplicate/exclude, typed comparisons, keyboard navigation, metadata retry, stale responses, and light/high-contrast layouts.
- Native VS Code 1.136.1 on macOS arm64 passed the filter and Query Builder flow, Model Browser/ORM Query stability checks, and foreign-key editing integrity checks. The updated E2E probe exercises the searchable field explorer and its focus behavior.
- Full VS Code E2E did not pass: the later Python console golden-visual check reported `Renderer transport timed out after 8000ms` in `assertGoldenHiddenPreludeVisualStability`. Keep this limitation visible for this local installation.
- The native run used the real Node executable with injected Node/Electron/DYLD hooks removed from the test process; Port Manager's runtime shims otherwise conflicted with the test inspector.

### 1.1.1000054 validation record — 2026-09-09

- `npm run check`: 1,022 tests passed with no failures or skips, including direct input quarantine, independent E2E extension directories, cross-process inspector reservations, and reservation release after process termination.
- Full VS Code E2E passed on VS Code 1.136.1, macOS arm64, after using the verified test-process activation helper for the automatic-completion probe. The previous hover verification failure is resolved in this release.
- Separate native hover checks passed at 1100×900, 1440×900, and 1740×900. Requested pointer delivery, portal retention, sash resizing, and cleanup were verified; the 1440px run recorded 24 unrelated pointer events that were isolated by the test guard.
- The recovery notice uses the existing terminal output and a single native VS Code warning so the instruction remains available while the setup terminal is minimized. After shortening its text, the final native notification and Model Browser E2E passed again; a 1440×900 screenshot confirmed the complete recovery instruction is visible without truncation.
- Actual SSH/WAN bootstrap behavior and the managed endpoint's SentinelOne detection status remain unverified. The versioned records below describe earlier releases.

### 1.1.1000053 validation record — 2026-09-08

- `npm run check`: 1,016 tests passed with no failures or skips.
- The Model Browser E2E suite passed in VS Code 1.136.1 on macOS arm64. Coverage includes two OR filters, keyboard Apply, Clear/Undo, host-side query validation, and foreign-key focus departure, return, selection, and save in both Model Data and ORM Query.
- The browser fixture passed filter interactions at 390, 768, and 1440 pixels wide, including light and forced-colors checks. It uses a simulated backend; the native suite above separately exercises the VS Code host boundary.
- Full VS Code E2E remains incomplete: the detached overlay hover closed after pointer handoff. The recorded events show successful entry and retention followed by a pointer event outside the test's requested path. Isolating that input and completing the hover/resize checks remain open; this is not a full-suite pass.
- Actual SSH/WAN bootstrap behavior and the managed endpoint's SentinelOne detection status remain unverified.
- The design sidecar was synchronized with `DESIGN.md` and checked for drift.

### 1.1.1000052 validation record — 2026-09-08

- `npm run check`: 1,010 tests passed with no failures or skips.
- The local PTY integration suite passed both cold/cached bootstrap and terminal restoration scenarios; actual SSH/WAN behavior remains unverified.
- Full VS Code E2E still fails at `focused and stable foreign-key cell` with `focus: false`. Preserve this open verification item when installing this version locally.
- SentinelOne detection status requires confirmation from the managed endpoint's administrator.

## Preflight

Run these checks from the repository root before packaging:

```sh
npm ci
npm run check
npm run test:e2e
```

`npm run check` enforces code guidelines, compiles TypeScript, bundles the renderer assets, and runs unit tests. `npm run test:e2e` launches VS Code and validates Model Browser, ORM Query, the custom console, overlay documents, restart reset behavior, and renderer guards. Each run owns a separate extensions directory, workspace, profile, and development extension; cleanup preserves other runs and the installed provider extensions. The runner disables extension updates and background timer throttling and focuses only its own window. Set `VSCODE_E2E_EXECUTABLE` to an existing VS Code executable when using a cached installation.

Both E2E entrypoints reserve an inspector port and verify the owning test process before activating its single workbench window. On macOS, activation targets that verified process ID. Webview focus uses Chromium pointer input, and typing waits for focus and stable geometry; completion timing records the first visible frame inside the renderer so inspector round trips do not inflate the 500ms budget.

Inspector candidates in 9229–9268 use companion loopback reservations in 9269–9308. The companion socket remains open for the run, preventing concurrent runners from choosing the same candidate before VS Code binds it. The OS releases the reservation when the runner exits, including abrupt termination; unrelated listeners are preserved.

Hover checks temporarily filter pointer events outside the requested path in the isolated test window. They require native endpoint, press, and release delivery before asserting hover retention and resizing. Diagnostics record ignored events, and cleanup always restores ordinary input. This guard runs only in the test harness.

The overlay checks require a Node inspector belonging to the test's VS Code process. If an injected local port-routing hook causes `address already in use` or `main inspector did not open`, run the test process without that hook and its runtime shims. Keep other applications and their listeners running.

Confirm the deployment icon is present:

```sh
file media/icon.png
```

Expected result: a 128 x 128 PNG.

## Local VSIX Package

Install or invoke VSCE:

```sh
npm run package
```

This produces a file like:

```text
django-shell-1.1.1000055.vsix
```

Install it into VS Code:

```sh
code --install-extension django-shell-1.1.1000055.vsix --force
```

After installation, reload VS Code and run `Django Shell: Open Console` from the command palette.

## Manual Smoke Test

Before sharing a VSIX, verify:

- The extension icon appears in the Extensions view.
- `Django Shell: Open Console` opens the custom console.
- The setup terminal accepts a Django shell command.
- After Django is ready, the Python input cell enables and the setup terminal minimizes.
- Python overlay completion/hover still works for the generated `.django-shell/console-cell.py` document.
- `Restart Kernel` clears previous Python input, output, and generated prelude imports.
- Closing the Django Shell tab removes the overlay editor without leaving stale UI in the workbench.

## Public Marketplace Release

Prepare the manifest, matching lockfile version, and changelog without creating an automatic version commit:

```sh
npm version patch --no-git-tag-version
npm run check
npm run test:e2e
```

After the checks pass, commit and push the release, package the VSIX, and install that package locally. Publish the exact same VSIX so the installed and distributed artifacts match:

```sh
npx @vscode/vsce login <publisher-id>
npx @vscode/vsce publish --packagePath django-shell-1.1.1000055.vsix
```

Use `npx @vscode/vsce publish patch`, `minor`, or `major` only when you want VSCE to bump the version automatically.

If Node cannot validate a certificate chain that is trusted by the operating system, use `NODE_OPTIONS=--use-system-ca` with VSCE on a Node version supporting that option. Keep TLS certificate verification enabled.

## Native Dependency Note

This extension depends on `node-pty`. Package and smoke-test on the target platform before distributing a VSIX internally. If the terminal fails to start after installation, rebuild or reinstall dependencies on the packaging machine, then rerun the full preflight and repackage.

## Package Contents

`.vscodeignore` filters package contents. Verify the resulting VSIX contains the runtime assets and excludes source, tests, logs, local configuration, and Python caches:

```text
media/**
node_modules/**
out/**
package.json
python/**
LICENSE
```

If a runtime asset is added later, check `.vscodeignore` and verify that it appears in the packaged archive.
