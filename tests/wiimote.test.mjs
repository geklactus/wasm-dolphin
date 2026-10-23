import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WIIMOTE_KEY_BINDINGS,
  DEFAULT_WIIMOTE_STATE,
  WIIMOTE_BUTTONS,
  cursorFromPointer,
  readWiimoteFromGamepad,
  resolveWiimoteKey,
  wiimoteStateFromInputs,
  wiimoteStatesEqual
} from "../src/wiimote.js";
import {
  WIIMOTE_STATE_SLOT_COUNT,
  readWiimoteStateSnapshot,
  writeWiimoteStateSnapshot
} from "../src/input-transport.js";

test("button bits mirror ciface::Web::Button", () => {
  // Source/Core/InputCommon/ControllerInterface/Web/Web.h (vendor patch 0069).
  assert.equal(WIIMOTE_BUTTONS.A, 1);
  assert.equal(WIIMOTE_BUTTONS.HOME, 1 << 6);
  assert.equal(WIIMOTE_BUTTONS.RIGHT, 1 << 10);
  assert.equal(WIIMOTE_BUTTONS.NUNCHUK_Z, 1 << 12);
  assert.equal(WIIMOTE_BUTTONS.NUNCHUK_SHAKE, 1 << 14);
  assert.equal(WIIMOTE_BUTTONS.CURSOR_VISIBLE, 1 << 15);
  assert.equal(WIIMOTE_BUTTONS.HAS_MOTION, 1 << 16);
});

test("keyboard defaults are Dolphin's desktop ones", () => {
  assert.equal(resolveWiimoteKey("Digit1"), "ONE");
  assert.equal(resolveWiimoteKey("KeyQ"), "MINUS");
  assert.equal(resolveWiimoteKey("Enter"), "HOME");
  assert.equal(resolveWiimoteKey("ControlLeft"), "NUNCHUK_C");
  assert.equal(resolveWiimoteKey("KeyW"), "STICK_UP");
  assert.equal(resolveWiimoteKey("KeyX"), null);
  for (const name of Object.values(DEFAULT_WIIMOTE_KEY_BINDINGS)) {
    assert.ok(name in WIIMOTE_BUTTONS || name.startsWith("STICK_"), name);
  }
});

test("the pointer over the game becomes a -1..1 cursor, off it none", () => {
  const rect = { left: 100, top: 50, width: 640, height: 480 };
  assert.deepEqual(cursorFromPointer(rect, 100, 50), { x: -1, y: -1 });
  assert.deepEqual(cursorFromPointer(rect, 420, 290), { x: 0, y: 0 });
  assert.deepEqual(cursorFromPointer(rect, 740, 530), { x: 1, y: 1 });
  assert.equal(cursorFromPointer(rect, 99, 50), null);
  assert.equal(cursorFromPointer(rect, 400, 531), null);
  assert.equal(cursorFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 0, 0), null);
});

test("keys, mouse and cursor combine into one state", () => {
  const state = wiimoteStateFromInputs({
    keys: new Set(["ONE", "STICK_UP", "STICK_LEFT"]),
    mouseButtons: new Set(["A"]),
    cursor: { x: 0.25, y: -0.5 }
  });
  assert.equal(state.buttons, WIIMOTE_BUTTONS.ONE | WIIMOTE_BUTTONS.A | WIIMOTE_BUTTONS.CURSOR_VISIBLE);
  assert.equal(state.stickX, -1);
  assert.equal(state.stickY, 1);
  assert.equal(state.cursorX, 0.25);
  assert.equal(state.cursorY, -0.5);
  assert.equal(state.accelUp, 1);

  const idle = wiimoteStateFromInputs({});
  assert.deepEqual(idle, { ...DEFAULT_WIIMOTE_STATE });
  assert.ok(wiimoteStatesEqual(idle, wiimoteStateFromInputs({ keys: new Set() })));
  assert.ok(!wiimoteStatesEqual(idle, state));
});

test("a standard gamepad maps like a Classic Controller, right stick pointing", () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  buttons[0].pressed = true;   // A
  buttons[7].value = 0.9;      // right trigger: Nunchuk C
  buttons[13].pressed = true;  // D-pad down
  const reading = readWiimoteFromGamepad({ buttons, axes: [0.5, -0.5, 0.0, 0.0] });
  assert.equal(reading.buttons, WIIMOTE_BUTTONS.A | WIIMOTE_BUTTONS.NUNCHUK_C | WIIMOTE_BUTTONS.DOWN);
  assert.ok(reading.stickX > 0.3 && reading.stickX < 0.5);
  assert.ok(reading.stickY > 0.3 && reading.stickY < 0.5, "gamepad Y is inverted into stick up");
  assert.equal(reading.cursor, null, "a centred right stick does not point");

  const pointing = readWiimoteFromGamepad({ buttons, axes: [0, 0, 1, -1] });
  assert.deepEqual(pointing.cursor, { x: 1, y: -1 });
  const combined = wiimoteStateFromInputs({ gamepad: pointing, cursor: { x: 0, y: 0.5 } });
  assert.equal(combined.cursorY, 0.5, "the mouse over the game wins over the right stick");
  assert.ok(combined.buttons & WIIMOTE_BUTTONS.CURSOR_VISIBLE);
  assert.equal(readWiimoteFromGamepad(null), null);
});

test("Wii Remote SAB snapshot round-trips as fixed point under the seqlock", () => {
  const view = new Int32Array(new SharedArrayBuffer(WIIMOTE_STATE_SLOT_COUNT * 4));
  writeWiimoteStateSnapshot(view, {
    buttons: WIIMOTE_BUTTONS.B | WIIMOTE_BUTTONS.CURSOR_VISIBLE,
    cursorX: -0.3333,
    cursorY: 0.5,
    stickX: 1,
    stickY: -1,
    accelUp: 1,
    inputGeneration: 5,
    sentAtEpochMs: 123456
  });
  const result = readWiimoteStateSnapshot(view);
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.buttons, WIIMOTE_BUTTONS.B | WIIMOTE_BUTTONS.CURSOR_VISIBLE);
  assert.equal(result.snapshot.cursorX, -0.3333);
  assert.equal(result.snapshot.cursorY, 0.5);
  assert.equal(result.snapshot.stickX, 1);
  assert.equal(result.snapshot.stickY, -1);
  assert.equal(result.snapshot.accelUp, 1);
  assert.equal(result.snapshot.gyroYaw, 0);
  assert.equal(result.snapshot.inputGeneration, 5);
  assert.equal(result.snapshot.sentAtEpochMsLow, 123456);
  assert.equal(view[15] & 1, 0, "the sequence is even once the write is published");

  Atomics.store(view, 15, view[15] | 1);
  assert.equal(readWiimoteStateSnapshot(view).status, "writer-active");
  assert.throws(() => writeWiimoteStateSnapshot(new Int32Array(4), {}), TypeError);
});
