# Changelog

All notable changes to this project will be documented in this file.

## [v3.6.1] — SDR WebUI Management & Terminal

### Added

#### Backend — SDR State & Profile APIs (`main/sdr.go`)
- **`SdrDeviceState` struct** — JSON-serializable per-dongle state (index, serial, idSet, role, PPM, gain, state).
- **`SdrInventory` struct** — Aggregates all connected SDR devices with active profile name and stack state.
- **`SdrRegionProfile` struct** — Defines a region profile with name, dongle-to-protocol assignments, PPM overrides, and editability flag.
- **`RegionProfilesResponse` struct** — Response envelope for profile listing API.
- **`getSdrInventory()`** — Builds live inventory from `rtl.GetDeviceCount()`, matching device pointers to assigned roles (UAT, ES, OGN, AIS).
- **`getSdrInventoryJSON()`** — JSON marshaller wrapper.
- **`getRegionProfilesResponse()`** — Returns built-in US/EU profiles and any saved Custom profile from settings.
- **`applyRegionProfile(profile string)`** — Applies US, EU, or Custom region profile by setting protocol enables and saving settings.

#### Backend — Settings Struct (`main/gen_gdl90.go`)
- **`SdrRegionProfiles`** field added to `settings` struct — stores user-defined Custom profile assignments (`map[string]SdrRegionProfile`, JSON-persisted with `omitempty`).
- `RegionSelected` comment updated to document value `3 = Custom`.

#### Backend — HTTP/WebSocket Handlers (`main/managementinterface.go`)
- **Terminal session management** — `terminalSessionCount`, `terminalSessionMu`, `maxTerminalSessions` (limit: 2 concurrent sessions).
- **`GET /getSdrState`** — Returns live SDR inventory as JSON.
- **`GET /getRegionProfiles`** — Returns available region profiles (US, EU, Custom) as JSON.
- **`POST /setRegionProfile`** — Accepts `{profile, assignments, ppmOverrides}`, saves Custom assignments, applies selected profile.
- **`WS /terminal`** — WebSocket-based root terminal:
  - Spawns `/bin/bash -l` with `TERM=xterm-256color`.
  - Gated behind `DeveloperMode` — rejects connection if developer mode is disabled.
  - Relays stdin/stdout over WebSocket with binary message support.
  - Handles JSON control messages (resize).
  - 15-minute idle timeout with warning at 14 minutes.
  - Session limit enforcement (max 2 concurrent).
  - Proper cleanup with deferred session count decrement.

#### Frontend — SDR Management Section (`web/plates/settings.html`, `web/plates/js/settings.js`)
- **Profile selector** — 3-button group (US / EU / Custom) with active-state highlighting.
- **SDR inventory cards** — Per-dongle display showing state badge (Running/Idle/Error), serial number, anonymous device warning, protocol assignment (dropdown for Custom, read-only for US/EU), PPM and gain readouts.
- **Custom profile controls** — Protocol role dropdowns per dongle, Apply Custom Profile button with duplicate-role validation.
- **Refresh SDR State button** — Re-fetches live dongle inventory.
- Controller functions: `refreshSdrState()`, `setSdrProfile()`, `updateCustomAssignment()`, `applyCustomProfile()`.

#### Frontend — Terminal Page (`web/plates/terminal.html`, `web/plates/js/terminal.js`, `web/plates/terminal-help.html`)
- **Terminal page** — Accessible from hamburger menu (Developer Mode only), full-page terminal with:
  - Connection status indicator (green/red badge).
  - Reconnect, Clear, and font size (S/M/L) controls.
  - Terminal container with black background, green text, monospace font.
  - Idle timeout countdown display.
  - Close Session button.
- **Terminal controller** (`TerminalCtrl`):
  - WebSocket connection management with auto-reconnect awareness.
  - Keyboard handler translating keys to terminal sequences (Enter, Backspace, arrows, Ctrl+key combos, Tab).
  - Paste support via clipboard API.
  - ANSI escape sequence stripping for `<pre>`-based renderer.
  - 5000-line scrollback buffer with auto-scroll.
  - JSON status message handling (connected, rejected, idle_warning, idle_timeout, exited).
  - Window resize handler with 250ms debounce and proper cleanup on scope destroy.
- **Help page** — Lists common commands (sdrs, sdr-tool.sh, rtl_test, dmesg, systemctl) and session notes.

#### Frontend — Navigation & Routing (`web/index.html`, `web/js/main.js`)
- **Terminal menu item** — Added to hamburger menu with `fa-terminal` icon, wrapped in `ng-show="DeveloperMode"`.
- **URL constants** — `URL_SDR_STATE_GET`, `URL_REGION_PROFILES_GET`, `URL_REGION_PROFILE_SET`, `URL_TERMINAL_WS`.
- **Terminal route** — `ui.router` state `terminal` pointing to `plates/terminal.html` with `TerminalCtrl`.
- **Script include** — `plates/js/terminal.js` added to index.html.

### Fixed
- **Idle timer operator precedence** (`managementinterface.go`) — Fixed `remaining` seconds calculation that produced incorrect values due to Go operator precedence (`/` binding tighter than `-`).
- **Resize listener leak** (`terminal.js`) — Fixed `removeEventListener` call that could never match the anonymous handler function; now uses a named function reference for both add and remove.
- **Dead variables removed** (`terminal.js`) — Removed 5 unused variable declarations (`inputBuffer`, `outputLines`, `cursorPos`, `historyBuf`, `historyIdx`).

### Security
- Terminal WebSocket endpoint is gated behind `globalSettings.DeveloperMode` on the backend.
- Terminal menu item is only visible when `DeveloperMode` is enabled in the UI.
- Terminal sessions are limited to 2 concurrent connections.
- 15-minute idle timeout automatically kills inactive sessions.

### Design Notes
- All UI follows the existing Stratux design language (Bootstrap panels, `panel-heading`/`panel-body` pattern, `mobile-angular-ui` components).
- No new Go dependencies added — terminal uses `os/exec` with piped stdin/stdout (no PTY).
- No new JavaScript dependencies — terminal uses a lightweight `<pre>`-based renderer instead of xterm.js.
- SDR state API reads live from `rtl.GetDeviceCount()` and existing global device pointers.

### Files Changed
| File | Action | Description |
|------|--------|-------------|
| `main/sdr.go` | Modified | Added SDR state types, inventory builder, region profile logic |
| `main/gen_gdl90.go` | Modified | Added `SdrRegionProfiles` field to settings struct |
| `main/managementinterface.go` | Modified | Added SDR API handlers, terminal WebSocket handler, route registrations |
| `web/index.html` | Modified | Added Terminal menu item, terminal.js script include |
| `web/js/main.js` | Modified | Added URL constants, terminal route state |
| `web/plates/settings.html` | Modified | Added SDR Management section |
| `web/plates/js/settings.js` | Modified | Added SDR management controller functions |
| `web/plates/terminal.html` | Created | Terminal page layout |
| `web/plates/terminal-help.html` | Created | Terminal help sidebar content |
| `web/plates/js/terminal.js` | Created | Terminal controller with WebSocket, keyboard, renderer |
| `CHANGELOG.md` | Created | This file |

### Future Work (from design document)
- **Phase 3 — Calibration:** ATSC/NOAA/VOR/rtl_test PPM calibration jobs with async job manager.
- **Phase 5 — Stack Control:** Data-plane start/stop with persistent WebUI state machine.
- **PTY integration:** Replace `os/exec` pipes with `github.com/creack/pty` for full interactive terminal (job control, readline, curses apps).
- **xterm.js:** Vendor xterm.js to replace lightweight `<pre>` renderer for full terminal emulation.

### Reference
- Design document: [`docs/sdr-webui-design.md`](docs/sdr-webui-design.md)
