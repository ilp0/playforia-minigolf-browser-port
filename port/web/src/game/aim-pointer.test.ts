import { test } from "node:test";
import assert from "node:assert/strict";
import { AimPointer } from "./aim-pointer.ts";

test("desktop: the aim line is always live", () => {
  const aim = new AimPointer(false);
  assert.equal(aim.live, true);
});

test("touch mode: no aim before any input", () => {
  const aim = new AimPointer(true);
  assert.equal(aim.live, false);
});

test("touch mode: a mouse still gets its aim line", () => {
  // Touch-screen laptop detected as a touch device, played with a mouse.
  const aim = new AimPointer(true);
  aim.mouseMoved();
  assert.equal(aim.live, true);
  assert.equal(aim.touching, false);
});

test("touch mode: a finger aims only while it is down", () => {
  const aim = new AimPointer(true);
  aim.touchStarted();
  assert.equal(aim.live, true);
  assert.equal(aim.touching, true);
  aim.touchEnded();
  assert.equal(aim.live, false);
  assert.equal(aim.touching, false);
});

test("touch mode: a touch ends the mouse aim until the mouse moves again", () => {
  const aim = new AimPointer(true);
  aim.mouseMoved();
  aim.touchStarted();
  aim.touchEnded();
  assert.equal(aim.live, false);
  aim.mouseMoved();
  assert.equal(aim.live, true);
});
