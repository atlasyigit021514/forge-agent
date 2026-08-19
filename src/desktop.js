import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ObservationStore, findControl, observationsChanged, windowKey } from "./desktop-state.js";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/windows-computer.ps1");
const observations = new ObservationStore();
const OCR_FIRST_PROCESSES = /RobloxStudioBeta|RobloxPlayerBeta|Discord|chrome|msedge/i;
let worker = null;
let requestNumber = 0;

function startWorker() {
  if (worker && worker.child.exitCode == null) return worker;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "worker"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
  const state = { child, pending: new Map(), buffer: "", errors: "" };
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk.toString();
    for (;;) {
      const newline = state.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = state.pending.get(String(response.id));
      if (!pending) continue;
      state.pending.delete(String(response.id)); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.result);
    }
  });
  child.stderr.on("data", (chunk) => { state.errors = `${state.errors}${chunk}`.slice(-6000); });
  child.on("exit", (code) => {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(state.errors.trim() || `Computer worker exited (${code})`));
    }
    state.pending.clear();
    if (worker === state) worker = null;
  });
  worker = state;
  return state;
}

function ps(action, args = {}, timeoutMs = 30_000) {
  if (process.platform !== "win32") throw new Error("Computer control is currently available on Windows only");
  return new Promise((resolve, reject) => {
    const state = startWorker();
    const id = String(++requestNumber);
    const timer = setTimeout(() => {
      state.pending.delete(id);
      if (worker === state) worker = null;
      state.child.kill();
      reject(new Error(`Computer action ${action} timed out; the worker was reset`));
    }, Math.min(Math.max(timeoutMs, 1000), 120_000));
    state.pending.set(id, { resolve, reject, timer });
    state.child.stdin.write(`${JSON.stringify({ id, action, args })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer); state.pending.delete(id); reject(error);
    });
  });
}

function modeOf(args = {}) {
  if (args.mode === "foreground" || args.focus === true) return "foreground";
  return "background";
}

function windowSummary(window) {
  return { processId: window.processId, process: window.process, title: window.title, handle: window.handle };
}

function selectWindow(windows, args = {}) {
  let matches = windows;
  if (args.processId != null) matches = matches.filter((window) => Number(window.processId) === Number(args.processId));
  if (args.handle != null) matches = matches.filter((window) => String(window.handle) === String(args.handle));
  if (args.query) {
    const query = String(args.query).toLocaleLowerCase("tr-TR");
    matches = matches.filter((window) => `${window.process} ${window.title}`.toLocaleLowerCase("tr-TR").includes(query));
  }
  if (!args.processId && !args.handle && !args.query) throw new Error("Select a target with processId, handle, or query");
  if (matches.length !== 1) {
    const candidates = matches.slice(0, 12).map(windowSummary);
    throw new Error(`${matches.length ? "Target is ambiguous" : "No matching window found"}; candidates=${JSON.stringify(candidates)}`);
  }
  return matches[0];
}

function ocrControls(result) {
  return (result.lines || []).map((line, index) => ({
    index,
    name: line.text,
    type: "OCRText",
    automationId: "",
    enabled: true,
    offscreen: false,
    bounds: line.bounds
  }));
}

function remember(result) {
  return observations.remember({ ...result, windowKey: windowKey(result.window) });
}

function compactObservation(observation) {
  if (!observation) return null;
  return {
    observationId: observation.observationId,
    window: observation.window,
    mode: observation.mode,
    method: observation.method,
    controls: observation.controls,
    imageHash: observation.imageHash,
    truncated: observation.truncated,
    elapsedMs: observation.elapsedMs
  };
}

export function warmComputerWorker() {
  return process.platform === "win32" ? listWindows() : Promise.resolve({ windows: [] });
}

export function listWindows() {
  return ps("windows", {}, 5000);
}

export async function observeDesktop(args = {}) {
  const mode = modeOf(args);
  const started = performance.now();
  const catalog = await listWindows();
  const target = selectWindow(catalog.windows || [], args);
  const diagnostics = [];
  const preferOcr = args.preferAccessibility !== true && OCR_FIRST_PROCESSES.test(target.process || "");

  if (!preferOcr) {
    try {
      const result = await ps("observe", {
        ...args,
        processId: target.processId,
        handle: target.handle,
        mode,
        focus: mode === "foreground"
      }, args.timeoutMs || 6000);
      if (result.controls?.length) {
        return remember({ ...result, window: result.window || target, mode, method: "accessibility", diagnostics, elapsedMs: Math.round(performance.now() - started) });
      }
      diagnostics.push("accessibility_empty");
    } catch (error) { diagnostics.push(`accessibility:${error.message}`); }
  }

  try {
    const result = await ocrDesktop({ ...args, processId: target.processId, handle: target.handle, mode, maxLines: args.maxElements || args.maxLines || 300 });
    return remember({
      window: result.window || target,
      mode,
      method: preferOcr ? "ocr_direct" : "ocr_fallback",
      controls: ocrControls(result),
      imageHash: result.imageHash,
      truncated: result.truncated,
      diagnostics,
      elapsedMs: Math.round(performance.now() - started)
    });
  } catch (error) {
    diagnostics.push(`ocr:${error.message}`);
    throw new Error(`Unable to observe ${target.process} (${target.processId}) in ${mode} mode: ${diagnostics.join("; ")}`);
  }
}

export function focusWindow(args) { return ps("focus", args, args.timeoutMs || 5000); }
export function clickDesktop(args = {}) { return ps("click", { ...args, mode: modeOf(args) }, args.timeoutMs || 5000); }
export function typeDesktop(args = {}) { return ps("type", { ...args, mode: modeOf(args) }, args.timeoutMs || 8000); }
export function keyDesktop(args = {}) { return ps("key", { ...args, mode: modeOf(args) }, args.timeoutMs || 5000); }
export function scrollDesktop(args = {}) { return ps("scroll", { ...args, mode: modeOf(args) }, args.timeoutMs || 5000); }
export function screenshotDesktop(args = {}) { return ps("screenshot", { ...args, mode: modeOf(args) }, args.timeoutMs || 15_000); }
export function launchDesktop(args = {}) {
  const mode = modeOf(args);
  return ps("launch", { ...args, mode, background: mode === "background" }, args.timeoutMs || 30_000);
}
export function ocrDesktop(args = {}) { return ps("ocr", { ...args, mode: modeOf(args) }, args.timeoutMs || 15_000); }

export async function navigateDesktop(args = {}) {
  const action = args.action || "open_url";
  let target;
  if (action === "youtube_search" || action === "youtube_play") target = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query || "")}`;
  else if (action === "web_search") target = `https://www.google.com/search?q=${encodeURIComponent(args.query || "")}`;
  else target = args.target;
  if (!target) throw new Error(`${action} requires ${action.includes("search") || action === "youtube_play" ? "query" : "target"}`);
  if (action === "youtube_play") {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const videoId = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/)?.[1];
      if (videoId) target = `https://www.youtube.com/watch?v=${videoId}`;
    } catch {}
  }
  const result = await launchDesktop({ target, arguments: args.arguments || [], waitMs: args.waitMs ?? 500, mode: modeOf(args), timeoutMs: args.timeoutMs });
  return { ...result, action, target };
}

async function performObservedAction(observation, control, args) {
  const mode = modeOf({ mode: args.mode || observation.mode });
  const common = { processId: observation.window.processId, handle: observation.window.handle, mode };
  const action = args.action || "click";
  if (control.type !== "OCRText") {
    if (action === "set_value" || action === "type") return ps("set_value", { ...common, elementIndex: control.index, value: args.value ?? args.text ?? "" }, args.timeoutMs || 6000);
    if (action !== "click" && action !== "invoke") throw new Error(`Accessibility control does not support action ${action}`);
    return ps("invoke", { ...common, elementIndex: control.index }, args.timeoutMs || 6000);
  }
  if (!control.bounds) throw new Error("OCR control has no clickable bounds");
  const x = Math.round(control.bounds.x + control.bounds.width / 2);
  const y = Math.round(control.bounds.y + control.bounds.height / 2);
  if (action === "click" || action === "invoke") return clickDesktop({ ...common, x, y, count: args.count || 1, button: args.button || "left" });
  if (action === "set_value" || action === "type") {
    const clicked = await clickDesktop({ ...common, x, y, count: 1 });
    if (clicked.ok === false) return clicked;
    return typeDesktop({ ...common, text: args.value ?? args.text ?? "", clearFirst: args.clearFirst !== false, pressEnter: args.pressEnter === true });
  }
  throw new Error(`Unsupported observed action: ${action}`);
}

export async function interactDesktop(args = {}) {
  const observation = observations.get(args, { consume: true });
  const control = observation.controls.find((item) => Number(item.index) === Number(args.elementIndex));
  if (!control) throw new Error(`Element ${args.elementIndex} is not part of observation ${observation.observationId}`);
  const requestedMode = modeOf({ mode: args.mode || observation.mode });
  if (observation.mode === "background" && requestedMode === "foreground" && args.mode !== "foreground") throw new Error("Foreground action requires explicit mode=foreground");

  const transport = await performObservedAction(observation, control, { ...args, mode: requestedMode });
  const shouldVerify = args.verify !== false;
  let after = null;
  let verificationError = null;
  if (shouldVerify) {
    await new Promise((resolve) => setTimeout(resolve, args.verifyDelayMs ?? (requestedMode === "background" ? 350 : 500)));
    try {
      after = await observeDesktop({ processId: observation.window.processId, handle: observation.window.handle, mode: requestedMode, maxElements: args.maxElements || 300 });
    } catch (error) { verificationError = error.message; }
  }
  const stateChanged = after ? observationsChanged(observation, after) : false;
  const expectChange = args.expectChange !== false;
  const backgroundRejected = requestedMode === "background" && expectChange && (!after || !stateChanged);
  return {
    ok: transport?.ok !== false && !backgroundRejected,
    action: args.action || "click",
    mode: requestedMode,
    element: control,
    transport,
    verified: Boolean(after),
    stateChanged,
    rejected: backgroundRejected ? "background_input_rejected" : undefined,
    verificationError,
    observation: compactObservation(after)
  };
}

export async function findAndActDesktop(args = {}) {
  if (!args.controlText) throw new Error("controlText is required");
  const observation = await observeDesktop(args);
  const found = findControl(observation.controls, args.controlText);
  if (!found.match) {
    return { ok: false, rejected: found.reason, controlText: args.controlText, candidates: found.candidates, observation: compactObservation(observation) };
  }
  return interactDesktop({ ...args, observationId: observation.observationId, elementIndex: found.match.index, mode: modeOf(args) });
}

export async function invokeDesktop(args = {}) {
  const observation = observations.get(args);
  return interactDesktop({ ...args, observationId: observation.observationId, action: "click" });
}

export async function setDesktopValue(args = {}) {
  const observation = observations.get(args);
  return interactDesktop({ ...args, observationId: observation.observationId, action: "set_value" });
}

export function resetDesktopStateForTests() { observations.clear(); }
