import test from "node:test";
import assert from "node:assert/strict";
import { quadrant, majority, ruleQuadrant, QUADRANTS } from "../src/classify.mjs";

test("quadrant covers all four cells of the README table", () => {
  assert.equal(quadrant("yes", "yes"), "redundant");
  assert.equal(quadrant("no", "yes"), "effective");
  assert.equal(quadrant("no", "no"), "ineffective");
  assert.equal(quadrant("yes", "no"), "harmful");
});

test("quadrant returns unknown whenever either side is unknown", () => {
  assert.equal(quadrant("unknown", "yes"), "unknown");
  assert.equal(quadrant("yes", "unknown"), "unknown");
  assert.equal(quadrant("unknown", "unknown"), "unknown");
});

test("quadrant returns unknown for values outside the verdict enum", () => {
  assert.equal(quadrant("maybe", "yes"), "unknown");
  assert.equal(quadrant("yes", null), "unknown");
  assert.equal(quadrant(undefined, undefined), "unknown");
});

test("quadrant only ever returns a documented quadrant", () => {
  for (const b of ["yes", "no", "unknown", "junk"]) {
    for (const f of ["yes", "no", "unknown", "junk"]) {
      assert.ok(QUADRANTS.includes(quadrant(b, f)), `${b}/${f}`);
    }
  }
});

test("majority picks the winner of a clear vote", () => {
  assert.equal(majority(["yes", "yes", "no"]), "yes");
  assert.equal(majority(["no", "no", "yes"]), "no");
  assert.equal(majority(["yes"]), "yes");
  assert.equal(majority(["unknown", "unknown", "yes"]), "unknown");
});

test("majority returns unknown on a tie rather than picking a side", () => {
  assert.equal(majority(["yes", "no"]), "unknown");
  assert.equal(majority(["yes", "no", "unknown"]), "unknown");
  assert.equal(majority(["yes", "yes", "no", "no"]), "unknown");
});

test("majority returns unknown for an empty or non-array input", () => {
  assert.equal(majority([]), "unknown");
  assert.equal(majority(null), "unknown");
  assert.equal(majority("yes"), "unknown");
});

test("ruleQuadrant returns the shared verdict when every probe agrees", () => {
  assert.deepEqual(ruleQuadrant(["effective"]), { quadrant: "effective" });
  assert.deepEqual(ruleQuadrant(["redundant", "redundant", "redundant"]), { quadrant: "redundant" });
  assert.deepEqual(ruleQuadrant(["unknown", "unknown"]), { quadrant: "unknown" });
});

test("ruleQuadrant reports disagreement instead of averaging it away", () => {
  assert.deepEqual(ruleQuadrant(["effective", "redundant"]), { quadrant: "unknown", note: "probes disagree" });
  assert.deepEqual(ruleQuadrant(["effective", "effective", "unknown"]), {
    quadrant: "unknown",
    note: "probes disagree",
  });
});

test("ruleQuadrant handles a rule with no probes", () => {
  assert.deepEqual(ruleQuadrant([]), { quadrant: "unknown", note: "no probes" });
  assert.deepEqual(ruleQuadrant(undefined), { quadrant: "unknown", note: "no probes" });
});
