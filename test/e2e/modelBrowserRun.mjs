// Runs only the isolated Model Browser webview E2E scenario.

process.env.DJANGO_SHELL_E2E_MODEL_BROWSER_ONLY = "1";
await import("./run.mjs");
