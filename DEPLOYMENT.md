# Deployment Guide

This document describes how to package and release the Django Shell VS Code extension.

## Current Release State

The extension is ready for local VSIX packaging after the standard checks pass. Public Marketplace publishing still needs product metadata cleanup:

- Replace `"license": "UNLICENSED"` if this extension should use an open-source license.
- Add Marketplace-facing `README.md` and `CHANGELOG.md` before public release.
- Keep `"icon": "media/icon.png"`; this is the 128x128 deployment icon.

The activity bar icon remains `media/django-shell.svg`. Do not use the colored deployment icon there because VS Code activity icons are expected to be theme-colored SVGs.

## Preflight

Run these checks from the repository root before packaging:

```sh
npm ci
npm run check
npm run test:e2e
```

`npm run check` enforces code guidelines, compiles TypeScript, bundles the renderer assets, and runs unit tests. `npm run test:e2e` launches VS Code and validates the custom console, overlay documents, restart reset behavior, and renderer guards.

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
django-shell-0.0.1.vsix
```

Install it into VS Code:

```sh
code --install-extension django-shell-0.0.1.vsix
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

Prepare the manifest and metadata:

```sh
npm version patch
npm run check
npm run test:e2e
```

Then authenticate and publish:

```sh
npx @vscode/vsce login <publisher-id>
npm run publish
```

Use `npx @vscode/vsce publish patch`, `minor`, or `major` only when you want VSCE to bump the version automatically.

## Native Dependency Note

This extension depends on `node-pty`. Package and smoke-test on the target platform before distributing a VSIX internally. If the terminal fails to start after installation, rebuild or reinstall dependencies on the packaging machine, then rerun the full preflight and repackage.

## Package Contents

`package.json` uses a `files` whitelist so VSIX packages include only runtime assets:

```text
media/**
node_modules/**
out/**
package.json
python/**
LICENSE
```

If a runtime asset is added later, update the `files` list before packaging.
