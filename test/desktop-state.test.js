import test from "node:test";
import assert from "node:assert/strict";
import { ObservationStore, findControl, observationsChanged } from "../src/desktop-state.js";

function observation(name = "New Experience", imageHash = "a") {
  return {
    window: { processId: 42, handle: 99, process: "Example", title: "Example" },
    mode: "background",
    controls: [{ index: 0, name, type: "OCRText", bounds: { x: 1, y: 2, width: 3, height: 4 } }],
    imageHash
  };
}

test("observations are window-bound and single-use", () => {
  const store = new ObservationStore();
  const saved = store.remember(observation());
  assert.equal(store.get({ observationId: saved.observationId }, { consume: true }).window.processId, 42);
  assert.throws(() => store.get({ observationId: saved.observationId }), /already used/);
});

test("control matching tolerates Turkish accents but rejects ambiguous labels", () => {
  const controls = [
    { index: 1, name: "Yeni Deneyim" },
    { index: 2, name: "Öğrenmeye başla" }
  ];
  assert.equal(findControl(controls, "ogrenmeye basla").match.index, 2);
  assert.equal(findControl([{ index: 1, name: "Open" }, { index: 2, name: "Open" }], "open").reason, "control_ambiguous");
});

test("image hashes provide deterministic action verification", () => {
  assert.equal(observationsChanged(observation("A", "same"), observation("B", "same")), false);
  assert.equal(observationsChanged(observation("A", "before"), observation("A", "after")), true);
});
