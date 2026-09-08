# Deployment Guide

This document describes how to package and release the Django Shell VS Code extension.

## Current Release State

The extension is published as `newdlops.django-shell`. Keep `package.json` and the root package entries in `package-lock.json` on the same release version, and add the user-visible changes to `CHANGELOG.md`.

The existing `UNLICENSED` manifest and proprietary `LICENSE` describe the current distribution terms. Keep `icon: media/icon.png` as the 128x128 Marketplace icon.

The activity bar icon remains `media/django-shell.svg`. Do not use the colored deployment icon there because VS Code activity icons are expected to be theme-colored SVGs.

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

`npm run check` enforces code guidelines, compiles TypeScript, bundles the renderer assets, and runs unit tests. `npm run test:e2e` launches VS Code and validates Model Browser, ORM Query, the custom console, overlay documents, restart reset behavior, and renderer guards. The test runner uses its own extensions directory, disables extension updates and background timer throttling, and focuses its own window for input probes; it must not load or update unrelated user extensions. Set `VSCODE_E2E_EXECUTABLE` to an existing VS Code executable when using a cached installation.

Both E2E entrypoints reserve an inspector port and verify the owning test process before activating its single workbench window. On macOS, activation targets that verified process ID. Webview focus uses Chromium pointer input, and typing waits for focus and stable geometry; completion timing records the first visible frame inside the renderer so inspector round trips do not inflate the 500ms budget.

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
django-shell-1.1.1000053.vsix
```

Install it into VS Code:

```sh
code --install-extension django-shell-1.1.1000053.vsix --force
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
npx @vscode/vsce publish --packagePath django-shell-1.1.1000053.vsix
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
