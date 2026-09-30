import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  EditorResponseError,
  failureDiagnostic,
  failureMessage,
} from "../lib/maintenance/consolidator/diagnostics";
import { JevResponseError } from "../lib/maintenance/consolidator/jev";
import { GatewayRequestError } from "../lib/maintenance/gateway";

test("Jev reason and Gateway status survive message-only Workflow serialization", () => {
  for (const error of [
    new EditorResponseError("truncated_output", { completion_tokens: 8192 }),
    new JevResponseError("choice_mass"),
    new GatewayRequestError("private response", {
      status: 503,
      retryable: true,
    }),
  ]) {
    const diagnostic = failureDiagnostic(error);
    assert.deepEqual(
      failureDiagnostic(new Error(failureMessage(diagnostic))),
      diagnostic,
    );
    assert.deepEqual(
      failureDiagnostic({ message: failureMessage(diagnostic) }),
      diagnostic,
    );
    assert.deepEqual(
      failureDiagnostic({ cause: { message: failureMessage(diagnostic) } }),
      diagnostic,
    );
    assert.deepEqual(failureDiagnostic(failureMessage(diagnostic)), diagnostic);
    const workflowError = runInNewContext("new Error(message)", {
      message: failureMessage(diagnostic),
    });
    assert.equal(workflowError instanceof Error, false);
    assert.deepEqual(failureDiagnostic(workflowError), diagnostic);
    assert.doesNotMatch(failureMessage(diagnostic), /private/);
  }
  assert.equal(
    failureDiagnostic(new JevResponseError("choice_mass")).code,
    "choice_mass",
  );
});

test("wrapped database errors retain SQLSTATE without query, detail or credentials", () => {
  const cause = Object.assign(new Error("secret detail"), { code: "57P03" });
  const error = new Error("private SQL query", { cause });
  assert.deepEqual(failureDiagnostic(error), {
    category: "database",
    code: "57P03",
    retryable: true,
  });
  assert.deepEqual(failureDiagnostic(new TypeError("private input")), {
    category: "internal",
    code: "TypeError",
    retryable: false,
  });
});
