import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditWorkflowActionPins,
  parseWorkflowActionPinArgs,
  updateWorkflowActionPins,
  type WorkflowActionPinResolver,
} from "../src/workflow-action-pins.ts";

test("workflow action pin audit rejects tag refs and missing version comments", () => {
  const audit = auditWorkflowActionPins({
    ".github/workflows/ci.yml": [
      "steps:",
      "  - uses: actions/checkout@v7",
      "  - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "  - uses: actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae # v5.0.5",
    ].join("\n"),
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(
    audit.issues.map((issue) => issue.message),
    [
      "actions/checkout must be pinned to a full 40-character commit SHA, not v7",
      "actions/setup-node must keep a human-readable version comment like # v6",
    ],
  );
  assert.equal(audit.pins.length, 3);
});

test("workflow action pin update rewrites SHA pins from version comments", async () => {
  const resolverCalls: Array<{ action: string; tag: string }> = [];
  const resolver: WorkflowActionPinResolver = async (action, tag) => {
    resolverCalls.push({ action, tag });
    if (action === "actions/checkout" && tag === "v7") {
      return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    }
    return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  };

  const result = await updateWorkflowActionPins(
    {
      ".github/workflows/ci.yml": [
        "steps:",
        "  - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
        "  - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6",
      ].join("\n"),
    },
    resolver,
  );

  assert.deepEqual(resolverCalls, [
    { action: "actions/checkout", tag: "v7" },
    { action: "actions/setup-node", tag: "v6" },
  ]);
  assert.deepEqual(result.changes.map((change) => `${change.action}@${change.tag}`), [
    "actions/checkout@v7",
    "actions/setup-node@v6",
  ]);
  assert.match(result.files[".github/workflows/ci.yml"], /actions\/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v7/);
  assert.match(result.files[".github/workflows/ci.yml"], /actions\/setup-node@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v6/);
});

test("workflow action pin args parse check and update modes", () => {
  assert.deepEqual(parseWorkflowActionPinArgs(["check"]), {
    command: "check",
    verifyRemote: false,
    write: false,
    workflowDir: ".github/workflows",
  });
  assert.deepEqual(parseWorkflowActionPinArgs(["check", "--verify-remote"]), {
    command: "check",
    verifyRemote: true,
    write: false,
    workflowDir: ".github/workflows",
  });
  assert.deepEqual(parseWorkflowActionPinArgs(["update", "--write", "--workflow-dir", "ci"]), {
    command: "update",
    verifyRemote: false,
    write: true,
    workflowDir: "ci",
  });
  assert.throws(() => parseWorkflowActionPinArgs(["update"]), /update requires --write/);
});
