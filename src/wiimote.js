// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Wii Remote 1 from the page's input. The core's ciface::Web backend (vendor patch 0069,
// Source/Core/InputCommon/ControllerInterface/Web) takes one state per remote through
// SetWiimoteState: a buttons word, the pointer over the game as the IR cursor, a Nunchuk
// stick, and optional motion. This module turns the keyboard, mouse and gamepad into that
// state; the transport and the worker carry it to the core.

// Mirrors ciface::Web::Button.
export const WIIMOTE_BUTTONS = Object.freeze({
  A: 1 << 0,
  B: 1 << 1,
  ONE: 1 << 2,
  TWO: 1 << 3,
  MINUS: 1 << 4,
  PLUS: 1 << 5,
  HOME: 1 << 6,
  UP: 1 << 7,
  DOWN: 1 << 8,
  LEFT: 1 << 9,
  RIGHT: 1 << 10,
  NUNCHUK_C: 1 << 11,
  NUNCHUK_Z: 1 << 12,
  SHAKE: 1 << 13,
  NUNCHUK_SHAKE: 1 << 14,
  CURSOR_VISIBLE: 1 << 15,
  HAS_MOTION: 1 << 16
});

// Digital stand-ins for the Nunchuk stick, kept out of the buttons word.
export const WIIMOTE_STICK_KEYS = Object.freeze({
  STICK_UP: "STICK_UP",
  STICK_DOWN: "STICK_DOWN",
  STICK_LEFT: "STICK_LEFT",
  STICK_RIGHT: "STICK_RIGHT"
});

// Dolphin's own desktop defaults for an emulated Wii Remote, so anyone who has used Dolphin
// with a keyboard and mouse knows them: 1 and 2, Q/E for -/+, Enter for Home, the arrows for
// the D-pad, WASD for the Nunchuk stick, left Ctrl/Shift for C/Z. Space shakes (Dolphin uses
// the middle mouse button, which laptops lack). The mouse: left click A, right click B.
export const DEFAULT_WIIMOTE_KEY_BINDINGS = Object.freeze({
  Digit1: "ONE",
  Digit2: "TWO",
  KeyQ: "MINUS",
  KeyE: "PLUS",
  Enter: "HOME",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "STICK_UP",
  KeyS: "STICK_DOWN",
  KeyA: "STICK_LEFT",
  KeyD: "STICK_RIGHT",
  ControlLeft: "NUNCHUK_C",
  ShiftLeft: "NUNCHUK_Z",
  Space: "SHAKE"
});

export const DEFAULT_WIIMOTE_MOUSE_BINDINGS = Object.freeze({
  0: "A",
  2: "B",
  1: "SHAKE"
});

// A standard-mapping gamepad held like a Classic Controller: face buttons A/B, X/Y as 1/2,
// bumpers -/+, triggers Z (left) and C (right), the left stick as the Nunchuk stick, the right
// stick as the pointer, the D-pad as the D-pad, the home button as Home, and either stick
// press as a shake.
export const STANDARD_GAMEPAD_WIIMOTE_BUTTONS = Object.freeze({
  0: "A",
  1: "B",
  2: "ONE",
  3: "TWO",
  4: "MINUS",
  5: "PLUS",
  6: "NUNCHUK_Z",
  7: "NUNCHUK_C",
  8: "MINUS",
  9: "PLUS",
  10: "SHAKE",
  11: "NUNCHUK_SHAKE",
  12: "UP",
  13: "DOWN",
  14: "LEFT",
  15: "RIGHT",
  16: "HOME"
});

export const DEFAULT_WIIMOTE_STATE = Object.freeze({
  buttons: 0,
  cursorX: 0,
  cursorY: 0,
  stickX: 0,
  stickY: 0,
  accelRight: 0,
  accelForward: 0,
  accelUp: 1,
  gyroPitch: 0,
  gyroRoll: 0,
  gyroYaw: 0
});

const GAMEPAD_STICK_DEADZONE = 0.15;
const GAMEPAD_POINTER_DEADZONE = 0.1;
const GAMEPAD_BUTTON_THRESHOLD = 0.5;

export function resolveWiimoteKey(code, bindings = DEFAULT_WIIMOTE_KEY_BINDINGS) {
  return bindings[code] ?? null;
}

// The pointer's position over an element as the IR cursor: -1..1 on both axes, +x right,
// +y down, clamped to the element. null when it is not over the element at all.
export function cursorFromPointer(rect, clientX, clientY) {
  const width = Number(rect?.width) || 0;
  const height = Number(rect?.height) || 0;
  if (width <= 0 || height <= 0) return null;
  const x = (Number(clientX) - rect.left) / width;
  const y = (Number(clientY) - rect.top) / height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x: clamp1(x * 2 - 1), y: clamp1(y * 2 - 1) };
}

export function readWiimoteFromGamepad(gamepad) {
  if (!gamepad) return null;
  let buttons = 0;
  for (const [index, name] of Object.entries(STANDARD_GAMEPAD_WIIMOTE_BUTTONS)) {
    const button = gamepad.buttons?.[Number(index)];
    const pressed = Boolean(button?.pressed) || (Number(button?.value) || 0) >= GAMEPAD_BUTTON_THRESHOLD;
    if (pressed) buttons |= WIIMOTE_BUTTONS[name];
  }
  const [leftX = 0, leftY = 0, rightX = 0, rightY = 0] = gamepad.axes ?? [];
  const stick = radialDeadzone(leftX, leftY, GAMEPAD_STICK_DEADZONE);
  // Per axis, so the stick's corners reach the screen's corners.
  const pointer = { x: axisDeadzone(rightX, GAMEPAD_POINTER_DEADZONE), y: axisDeadzone(rightY, GAMEPAD_POINTER_DEADZONE) };
  const pointing = pointer.x !== 0 || pointer.y !== 0;
  return {
    buttons,
    // Gamepad Y axes grow downward; the Nunchuk stick's Y grows upward.
    stickX: stick.x,
    stickY: -stick.y,
    cursor: pointing ? { x: pointer.x, y: pointer.y } : null
  };
}

// Combine the keyboard (a Set of binding names), the mouse (pressed button names and the
// cursor, or null when the pointer is off the game) and a gamepad reading into one state.
// The pointer wins over the gamepad's right stick when it is over the game.
export function wiimoteStateFromInputs({ keys = null, mouseButtons = null, cursor = null, gamepad = null } = {}) {
  let buttons = 0;
  let stickX = 0;
  let stickY = 0;
  for (const name of keys ?? []) {
    if (name in WIIMOTE_BUTTONS) buttons |= WIIMOTE_BUTTONS[name];
    else if (name === WIIMOTE_STICK_KEYS.STICK_UP) stickY += 1;
    else if (name === WIIMOTE_STICK_KEYS.STICK_DOWN) stickY -= 1;
    else if (name === WIIMOTE_STICK_KEYS.STICK_LEFT) stickX -= 1;
    else if (name === WIIMOTE_STICK_KEYS.STICK_RIGHT) stickX += 1;
  }
  for (const name of mouseButtons ?? []) {
    if (name in WIIMOTE_BUTTONS) buttons |= WIIMOTE_BUTTONS[name];
  }
  if (gamepad) {
    buttons |= gamepad.buttons >>> 0;
    if (stickX === 0 && stickY === 0) {
      stickX = gamepad.stickX;
      stickY = gamepad.stickY;
    }
  }
  const point = cursor ?? gamepad?.cursor ?? null;
  if (point) buttons |= WIIMOTE_BUTTONS.CURSOR_VISIBLE;
  return {
    ...DEFAULT_WIIMOTE_STATE,
    buttons: buttons >>> 0,
    cursorX: point ? clamp1(point.x) : 0,
    cursorY: point ? clamp1(point.y) : 0,
    stickX: clamp1(stickX),
    stickY: clamp1(stickY)
  };
}

export function wiimoteStatesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  for (const key of Object.keys(DEFAULT_WIIMOTE_STATE)) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function axisDeadzone(value, threshold) {
  const number = clamp1(value);
  const magnitude = Math.abs(number);
  if (magnitude < threshold) return 0;
  return Math.sign(number) * Math.min(1, (magnitude - threshold) / (1 - threshold));
}

function radialDeadzone(x, y, threshold) {
  const magnitude = Math.hypot(Number(x) || 0, Number(y) || 0);
  if (magnitude < threshold) return { x: 0, y: 0 };
  const scale = Math.min(1, (magnitude - threshold) / (1 - threshold)) / magnitude;
  return { x: clamp1((Number(x) || 0) * scale), y: clamp1((Number(y) || 0) * scale) };
}

function clamp1(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(-1, number));
}
