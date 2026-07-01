// Unit tests for SSH debug port-forward helpers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseSshExecTarget, sshPortForwardArgs } = require("../out/sshPortForward.js");

test("parses ssh targets for automatic debug port-forwarding", () => {
  assert.deepEqual(parseSshExecTarget("ssh -p 2222 -i ~/.ssh/app.pem deploy@example.com"), {
    args: ["-p", "2222", "-i", "~/.ssh/app.pem"],
    destination: "deploy@example.com"
  });
  assert.deepEqual(parseSshExecTarget("ssh -J bastion app-host -- cd /srv/app && python manage.py shell_plus"), {
    args: ["-J", "bastion"],
    destination: "app-host"
  });
  assert.deepEqual(parseSshExecTarget("ssh -p2222 app-host"), {
    args: ["-p2222"],
    destination: "app-host"
  });
});

test("builds ssh local port-forward args", () => {
  const args = sshPortForwardArgs({ args: ["-p", "2222"], destination: "deploy@example.com" }, 45678, 56789);

  assert.deepEqual(args, ["-p", "2222", "-o", "ExitOnForwardFailure=yes", "-N", "-L", "127.0.0.1:45678:127.0.0.1:56789", "deploy@example.com"]);
});
