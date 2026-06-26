// Unit tests for kubectl debug port-forward helpers.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { kubectlPortForwardArgs, parseKubectlExecTarget } = require("../out/kubectlPortForward.js");

test("parses kubectl exec pod targets for automatic debug port-forwarding", () => {
  assert.deepEqual(parseKubectlExecTarget("kubectl -n alpha --context dev exec -it payroll-api -- bash"), {
    context: "dev",
    namespace: "alpha",
    resource: "pod/payroll-api"
  });
  assert.deepEqual(parseKubectlExecTarget("kubectl exec -it -n beta pod/payroll-api -c web -- python manage.py shell_plus"), {
    context: undefined,
    namespace: "beta",
    resource: "pod/payroll-api"
  });
  assert.deepEqual(parseKubectlExecTarget("kubectl exec deploy/payroll -- bash"), {
    context: undefined,
    namespace: undefined,
    resource: "deploy/payroll"
  });
});

test("builds kubectl port-forward args without requiring remote configuration changes", () => {
  const args = kubectlPortForwardArgs({ context: "dev", namespace: "alpha", resource: "pod/payroll-api" }, 45678, 56789);

  assert.deepEqual(args, ["--context", "dev", "--namespace", "alpha", "port-forward", "pod/payroll-api", "45678:56789"]);
});
