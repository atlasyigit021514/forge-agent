---
name: fast-computer-use
description: Complete Windows app, browser, Discord, Roblox Studio, and interactive command tasks with ForgeAgent's fast verified tools. Use when a request opens or operates desktop software or when a command may pause for user input.
---

# Fast Computer Use

Choose the highest-level deterministic tool that can finish the request. Use filesystem, shell, app-specific, or navigation tools before pixel interaction.

## Execution mode

- Background is the default. Keep it for every computer call unless the user explicitly asks to see or watch the interaction in foreground.
- A background request must never call `computer_focus`, switch to foreground, or retry a rejected action in foreground.
- Foreground mode is appropriate only when the user explicitly asks for foreground interaction.

## Fast paths

- Opening a URL, searching, or finding and playing a YouTube video: call `computer_navigate` once. Do not list windows, observe, OCR, or load shell first.
- Creating or scripting a Roblox game in background: call `roblox_project` once with `action: "build_place"` and include all requested scripts. It creates and verifies the `.rbxlx` place atomically. Open it in Studio only when foreground was explicitly requested.
- Acting on a known visible label in an existing app: call `computer_find_and_act` once with a window selector and `controlText`.
- Running a command that may prompt: use `shell_run`. It keeps the process alive and automatically pauses the task when input is requested. Use `shell_wait` for later output; do not restart the command.

## UI fallback

When the target text is unknown, call `computer_observe` once on exactly one window. Use its `observationId` and element index with `computer_interact`. Each observation is single-use; continue from the refreshed observation returned by the action.

Use accessibility controls when returned. OCR controls are a fallback for canvas, Electron, Chromium, Roblox, and other sparse interfaces. Do not use `computer_screenshot` for navigation.

Treat `ok: false`, `background_input_rejected`, an expired observation, or an unchanged verified state as a real failure. Do not repeat the same action. Switch to an app-specific, file, shell, URI, or keyboard method when one exists; otherwise report the exact limitation without bringing the app forward.

Finish only after the tool result verifies the requested outcome. There is no artificial turn target: use the fewest calls that reliably complete the task.
