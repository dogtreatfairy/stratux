# SDR Configuration & Calibration WebUI Design

## Purpose

This document defines a technical design for adding SDR role assignment, tuning profile management, and calibration workflows to the Stratux web UI without requiring SSH/CLI usage.

The design is based on the current Stratux architecture and is intended to be implementation-ready.

## Current Behavior (Baseline)

- SDR role detection is based on RTL-SDR EEPROM serial strings (e.g. `stratux:978`, `stratux:1090`, `stratux:868`, `stratux:162`) parsed in `main/sdr.go`.
- Anonymous dongles are assigned in fallback order if role-tagged dongles are not available.
- SDR workers are managed in-process by `sdrWatcher()`; changing existing settings like `UAT_Enabled`, `ES_Enabled`, `PPM`, or `Dump1090Gain` does not require restarting `stratux.service`.
- `sdr-tool.sh` currently stops the full service, modifies EEPROM serials with `rtl_eeprom`, then restarts service.
- Web UI does not currently expose per-dongle identity/status, per-dongle role assignment, or calibration jobs.
- Region choice exists only as a first-run style modal on the Status page (`US`/`EU`), not as a persistent Settings selector with explicit profile switching semantics.

## Goals

1. Configure each SDR from web UI to operate as US/UAT, EU/OGN, 1090, or AIS role independently.
2. View reliable per-SDR identity/status in web UI.
3. Run PPM calibration from web UI using modern RF references (ATSC TV pilots, VOR, NOAA weather radio, or `rtl_test`).
4. Avoid full `stratux` service stop/restart during SDR operations whenever possible.
5. Ensure SDR identity is stable across reboot and USB port changes for the same physical dongle.
6. Provide a durable region/profile selector in Settings that hot-switches between `US`, `EU`, and `Custom` SDR profiles.
7. Persist independent SDR role/PPM mappings per profile (e.g. `US: SDR0->978, SDR1->1090`, `EU: SDR0->868, SDR1->1090`, `Custom: SDR0->978, SDR1->868`).
8. Allow users to stop/start Stratux background receive/processing stack without losing WebUI availability.
9. Provide a fully user-configurable Custom profile where any supported protocol can be assigned to any dongle.
10. Provide a browser-based root terminal (WebUI Terminal) so operators can run shell commands (`sdr-tool.sh`, `sdrs`, `kal`, `rtl_test`, etc.) without requiring SSH access.

## Non-Goals

- Replacing all existing region selection logic in one step.
- Supporting role assignment for non-RTL SDR hardware in this phase.
- Redesigning Status/Settings UI beyond SDR-specific sections.
- Replacing systemd service management. (`systemctl stop stratux`) still stops everything including WebUI.

## Definitions

- **Region profile**: A named configuration set (`US`, `EU`, or `Custom`) containing SDR protocol enablement and per-SDR role/PPM mapping.
- **Built-in profile**: `US` or `EU` — preset protocol assignments, user can still adjust PPM per dongle.
- **Custom profile**: User-defined profile where any supported protocol (`978`, `1090`, `868`, `162`) can be freely assigned to any dongle, enabling non-standard combinations like `978 + 868`.
- **Hot switch**: Applying a different profile without restarting `stratux.service` and while keeping the management UI reachable.
- **WebUI Terminal**: A browser-based interactive terminal emulator (xterm.js) connected to a server-side PTY, providing full root shell access through the management interface.

---

## Architecture Overview

### Key Decision: Identity vs Role Separation

Use **EEPROM serial** as the **stable device identity** for RTL dongles, because it persists across reboot and USB port order changes. Do NOT use the EEPROM serial to encode the active role — role comes from the active profile at runtime.

Serial format to standardize for **identity** (not role):

- `stx:dev:<label>:<ppm>` where label is a stable device identity (e.g. `A`, `B`).
- The label does not encode protocol; it only identifies which physical dongle is which.

Legacy serial format (still supported):

- `stx:<role>:<ppm>` or `stratux:<role>` — existing installs use role-encoded serials like `stratux:978`, `stratux:1090`.
- These must remain functional for backward compatibility.
- On legacy serials, the parsed role serves as a **hint** for auto-assignment when no explicit profile mapping exists.
- Migration to neutral identity labels is optional and offered via the UI.

Backward compatibility:

- Existing `stratux:<role>` prefixes must remain supported.
- Existing regex matching in `sdr.go` already tolerates `stx`/`stratux` variants.
- When explicit profile mappings exist, they take precedence over EEPROM serial role parsing.

### Runtime Control Model

Do not restart service for normal role/profile changes.

Instead:

- Add SDR control orchestrator in-process.
- Pause/reconfigure only affected SDR workers.
- Keep management interface alive (web server remains reachable).

EEPROM write operations (`rtl_eeprom`) require temporary release of the affected dongle. This is done by stopping only SDR worker(s), not the whole service.

### Control Plane vs Data Plane split

To support "stop stratux but keep WebUI", process responsibilities are split logically:

- **Control Plane (always-on while service is running):**
  - management interface HTTP/WebSocket server
  - settings/profile persistence
  - job manager and orchestration API
- **Data Plane (start/stop by user):**
  - SDR watchers/readers and demodulator child processes
  - traffic ingestion loops
  - optional GPS/AHRS read loops (policy configurable)

Important constraint:

- This feature is **not** a systemd service stop/start replacement.
- If user executes `systemctl stop stratux`, WebUI will stop.
- WebUI-only stop/start controls operate on the Data Plane inside the running process.

### WebUI Terminal Architecture

The WebUI Terminal provides an interactive root shell session from the browser, eliminating the need for SSH to run diagnostic and configuration tools (`sdr-tool.sh`, `sdrs`, `kal`, `rtl_test -p`, `rtl_eeprom`, `dmesg`, etc.).

**Components:**

```
  Browser (xterm.js)  <──WebSocket──>  Go WS handler  <──PTY──>  /bin/bash (root)
       ↕                                    ↕                        ↕
  Terminal rendering              Binary frame relay           Full shell session
  Keyboard capture                Resize (SIGWINCH)            All system commands
  xterm-addon-fit                 Session lifecycle            sdr-tool.sh, sdrs, etc.
```

**Backend (`managementinterface.go`):**

- New WebSocket endpoint: `/terminal`
- On connection: allocate a PTY via `github.com/creack/pty`, spawn `/bin/bash` as root
- Use `github.com/gorilla/websocket` for binary-framed WS (existing `golang.org/x/net/websocket` is text-oriented and unsuitable for raw terminal I/O)
- Bidirectional relay:
  - WS text frames → PTY stdin (keyboard input)
  - PTY stdout → WS binary frames (terminal output)
  - WS JSON control frames → PTY resize (`TIOCSWINSZ` via `pty.Setsize`)
- Session lifecycle:
  - One active PTY session per WebSocket connection
  - Maximum concurrent sessions: configurable, default `2` (prevents resource exhaustion)
  - Idle timeout: `15 minutes` of no input → session killed with warning message
  - On WS disconnect: send `SIGHUP` to PTY process group, close PTY fd
  - On stratux service stop: all terminal sessions terminated gracefully

**Frontend (`web/plates/`):**

- New page: `terminal.html` with dedicated Angular route
- Embed [xterm.js](https://xtermjs.org/) (MIT license) terminal emulator
- Required xterm.js addons:
  - `xterm-addon-fit` — auto-resize terminal to container
  - `xterm-addon-web-links` — clickable URLs in output
- Assets served from `web/plates/js/` (vendored, not CDN — Stratux runs on an isolated WiFi AP with no internet)
- WebSocket connection management:
  - Connect on page load, reconnect on disconnect with backoff
  - Send resize events on window/container resize via `FitAddon`
  - Display connection status overlay (connected/disconnected/reconnecting)

**Message Protocol (WebSocket frames):**

| Direction | Type | Content |
|---|---|---|
| Client → Server | text | Raw keyboard input bytes |
| Client → Server | text (JSON) | `{"type":"resize","cols":N,"rows":N}` |
| Server → Client | binary | Raw PTY output bytes |
| Server → Client | text (JSON) | `{"type":"status","msg":"..."}` (connect/disconnect/timeout notices) |

**Dependencies (new):**

| Package | Purpose | License |
|---|---|---|
| `github.com/creack/pty` | PTY allocation and resize on Linux | MIT |
| `github.com/gorilla/websocket` | Binary WebSocket framing (upgrade from indirect to direct) | BSD-2 |
| `xterm.js` (JS, vendored) | Browser terminal emulator | MIT |
| `xterm-addon-fit` (JS, vendored) | Auto-resize addon | MIT |
| `xterm-addon-web-links` (JS, vendored) | Clickable URL addon | MIT |


### Identity vs Assignment (Core Rule)

To support reliable profile hot switching, Stratux must treat these as separate concerns:

- **Identity (persistent):** "which physical SDR is this?" — from EEPROM serial (survives reboot/port swap).
- **Assignment (profile-dependent):** "what role/frequency should this SDR run now?" — from active profile mapping at runtime.

Design rule:

- SDR EEPROM serial is used only for stable identity and optional per-device static metadata (like calibration PPM baseline).
- Active frequency/protocol role is selected by the active profile at runtime.
- EEPROM is NOT rewritten during normal profile switches.
- Legacy role-encoded serials (`stratux:978`, etc.) serve as assignment hints only when no explicit profile mapping exists.

### How Existing `configDevices()` Maps to This

The current `configDevices()` in `sdr.go` uses a two-pass approach:

1. **Pass 1 (tagged):** Scans all devices, matches EEPROM serial against role regex patterns (`rUAT`, `rES`, `rOGN`, `rAIS`), creates device of matching type.
2. **Pass 2 (anonymous):** Remaining unmatched devices are assigned to any still-needed protocol in priority order (UAT > ES > OGN > AIS).

With profile-based assignment, this changes to:

1. **Pass 1 (profile-mapped):** For each SDR in the active profile's config, find the physical device by `deviceKey` and create the device with the profile's `desiredRole`.
2. **Pass 2 (fallback):** Any remaining devices not in the profile use legacy serial-based assignment as fallback.

This is backward-compatible: existing installs with no profile mappings continue using the serial regex path unchanged. New profile mappings override the serial-based logic.

### `changeRegionSettings()` Replacement

The current `changeRegionSettings()` function hard-codes US/EU behavior:

```go
// Current (to be replaced):
case 1: UAT_Enabled=true, OGN_Enabled=false, DeveloperMode=false
case 2: UAT_Enabled=false, OGN_Enabled=true, DeveloperMode=true
```

This must be replaced with the generic Protocol Enablement Derivation described above, which computes enablement from any profile's SDR assignments. The replacement function should:

1. Load `SdrRegionProfiles[ActiveRegionProfile]`.
2. Scan assignments to compute `*_Enabled` booleans.
3. Set `DeveloperMode = OGN_Enabled || AIS_Enabled`.
4. Save settings.
5. `sdrWatcher()` picks up changed booleans on next iteration (~1s).

### Canonical 2-SDR Switching Mechanism

For the common two-dongle setup:

- **SDR A** = variable weather/region radio
- **SDR B** = fixed 1090 radio

Saved profiles:

- `US` profile: `A -> 978`, `B -> 1090`
- `EU` profile: `A -> 868`, `B -> 1090`
- `Custom` profile: user-defined, e.g. `A -> 978`, `B -> 868` (no 1090)

Switching behavior when user selects a profile:

1. Persist `ActiveRegionProfile`.
2. Load target mapping from `SdrRegionProfiles[ActiveRegionProfile]`.
3. Derive protocol enablement booleans from the mapping (see "Protocol Enablement Derivation" below).
4. Apply changes via `sdrWatcher()` live reconfiguration path.
5. Publish updated runtime status to UI.

**Current sdrWatcher() behavior (important):** When any enabled-protocol flag, gain, or device count changes, `sdrWatcher()` tears down **all** active SDR workers and calls `configDevices()` to rebuild from scratch. This means profile switches briefly interrupt all receivers (including unchanged ones like 1090). The interruption is sub-second and does not require a service restart. Selective per-device restart is a potential future optimization but is not required for correctness — the full teardown/rebuild approach is safe and already proven.

Expected outcome:

- Profile switch reconfigures SDR assignments live.
- All receivers restart within ~1 second.
- Web UI remains available because service is not restarted.

### Protocol Enablement Derivation

When a profile is applied, the `*_Enabled` booleans must be computed from the profile's SDR assignments rather than hard-coded:

```
UAT_Enabled  = any SDR in profile has role "978"
ES_Enabled   = any SDR in profile has role "1090"
OGN_Enabled  = any SDR in profile has role "868"
AIS_Enabled  = any SDR in profile has role "162"
```

This replaces the current `changeRegionSettings()` approach of toggling specific booleans per region.

`DeveloperMode` derivation:

- Set `DeveloperMode = true` if OGN or AIS is enabled (required for EU/non-US protocol features to function).
- Built-in profiles inherit this automatically. Custom profiles derive it from assignments.

### Custom Profile Behavior

The Custom profile differs from US/EU in these ways:

- **No preset role assignments.** User explicitly picks the protocol for each detected dongle.
- **All protocol combinations are valid** across multiple dongles (e.g. 978+868, 978+162, 868+162, 1090+868, etc.).
- **Single-dongle setups** can pick any one protocol.
- **Protocol enablement** is derived from assignments (see above), not hard-coded.
- **Validation rules:**
  - Each protocol can be assigned to at most one dongle (no duplicate 978, etc.).
  - A dongle can be set to `disabled` if the user wants to leave it unused.
  - Warning if user assigns more protocols than available dongles.
  - Warning shown (not blocking) if no 1090 is assigned — user may intentionally skip it.

Example Custom profile configurations:

| Setup | SDR A | SDR B | Use Case |
|---|---|---|---|
| Dual-band non-ADS-B | 978 | 868 | UAT weather + OGN traffic in mixed airspace |
| AIS + traffic | 1090 | 162 | Coastal/marine aviation |
| OGN + AIS | 868 | 162 | EU glider + maritime |
| Single UAT only | 978 | disabled | US weather-only receiver |

---

## Data Model Changes

## `settings` additions (proposed)

```go
type SdrRole string

const (
    SdrRoleAuto     SdrRole = "auto"     // maps to role serial 0 / legacy fallback
    SdrRole978      SdrRole = "978"      // US UAT
    SdrRole1090     SdrRole = "1090"     // ADS-B ES
    SdrRole868      SdrRole = "868"      // EU OGN
    SdrRole162      SdrRole = "162"      // AIS maritime
    SdrRoleDisabled SdrRole = "disabled" // dongle present but not used
)

type SdrUserConfig struct {
    DeviceKey   string  // stable synthetic key from EEPROM info
    DesiredRole SdrRole // requested role assignment
    DesiredPPM  *int    // nil means keep existing parsed/default
    Enabled     bool    // explicit enable override from UI
}

type settings struct {
    // existing fields...
  ActiveRegionProfile string // "US" | "EU" | "Custom"
  SdrConfigs []SdrUserConfig
  SdrRegionProfiles map[string][]SdrUserConfig // key: "US"|"EU"|"Custom"
}
```

Notes:

- `SdrConfigs` persists explicit user mapping intent and enables deterministic behavior.
- Existing booleans (`UAT_Enabled`, `ES_Enabled`, `OGN_Enabled`, `AIS_Enabled`) remain initially for compatibility and phased migration.
- `SdrRegionProfiles` stores separate SDR mappings per profile (US, EU, Custom).
- `ActiveRegionProfile` determines which mapping is applied live.
- Existing `RegionSelected` (int) remains during migration: `0=none`, `1=US`, `2=EU`, `3=Custom`. Maps to `ActiveRegionProfile` string.
- Custom profile stores user-defined assignments; US/EU profiles store preset assignments (user can still customize PPM).

## `status` additions (proposed)

```go
type SdrRuntimeState struct {
    DeviceKey         string
    DeviceIndex       int
    SerialRaw         string
    ParsedRole        string
    ParsedPPM         int
    Driver            string
    IsAssigned        bool
    AssignedProtocol  string // UAT/ES/OGN/AIS/none
    ReaderState       string // running/stopped/error
    LastError         string
    LastSeen          time.Time
}

type SdrJobState struct {
    JobID             string
    Type              string // write-serial, ppm-calibrate, atsc-scan, etc.
    DeviceKey         string
    State             string // queued/running/success/failed/canceled
    StartedAt         time.Time
    FinishedAt        time.Time
    ProgressPct       int
    Message           string
    OutputTail        []string
}

type status struct {
    // existing fields...
    SdrStates         []SdrRuntimeState
    SdrActiveJobs     []SdrJobState
  StackState        string // running|stopped|starting|stopping|error
  StackLastError    string
}
```

---

## API Contract

All endpoints use existing JSON conventions and management interface auth model.

## Read APIs

### `GET /getStackState`

Returns current Data Plane state.

Response:

```json
{
  "stackState": "running",
  "stackLastError": ""
}
```

### `GET /getRegionProfiles`

Returns active profile and all profile payloads (US, EU, Custom).

Response:

```json
{
  "activeRegionProfile": "US",
  "profiles": {
    "US": [
      {"deviceKey": "rtl:...A", "desiredRole": "978", "desiredPPM": -42, "enabled": true},
      {"deviceKey": "rtl:...B", "desiredRole": "1090", "desiredPPM": 3, "enabled": true}
    ],
    "EU": [
      {"deviceKey": "rtl:...A", "desiredRole": "868", "desiredPPM": -42, "enabled": true},
      {"deviceKey": "rtl:...B", "desiredRole": "1090", "desiredPPM": 3, "enabled": true}
    ],
    "Custom": [
      {"deviceKey": "rtl:...A", "desiredRole": "978", "desiredPPM": -42, "enabled": true},
      {"deviceKey": "rtl:...B", "desiredRole": "868", "desiredPPM": 3, "enabled": true}
    ]
  }
}
```

### `GET /getSdrState`

Returns full SDR runtime inventory and assignment state.

Response:

```json
{
  "sdrs": [
    {
      "deviceKey": "rtl:vendor=0bda,product=2838,serial=stx:978:-42",
      "deviceIndex": 0,
      "serialRaw": "stx:978:-42",
      "parsedRole": "978",
      "parsedPPM": -42,
      "assignedProtocol": "UAT",
      "readerState": "running",
      "lastError": ""
    }
  ],
  "jobs": []
}
```

### `GET /getSdrJob?jobId=<id>`

Returns a single async job state/output tail.

## Write APIs

### `POST /stack/stop`

Stops Stratux background Data Plane while leaving WebUI/control plane alive.

Request:

```json
{
  "reason": "user_request"
}
```

Response:

```json
{
  "ok": true,
  "stackState": "stopping"
}
```

### `POST /stack/start`

Starts Stratux background Data Plane using current active settings/profile.

Request:

```json
{
  "reason": "user_request"
}
```

Response:

```json
{
  "ok": true,
  "stackState": "starting"
}
```

### `POST /setRegionProfile`

Durable profile selector and hot switch trigger. Supports US, EU, and Custom profiles.

Request:

```json
{
  "activeRegionProfile": "Custom",
  "applyNow": true
}
```

For Custom profile, the profile's SDR assignments must already be saved via `/setSdrConfig` with `"profile": "Custom"` before activating.

Response:

```json
{
  "ok": true,
  "activeRegionProfile": "Custom",
  "warnings": []
}
```

Behavior:

- Persists active profile selection.
- Derives protocol enablement booleans from the selected profile's SDR assignments (see Protocol Enablement Derivation).
- Applies selected profile via same live orchestration path as `/setSdrConfig`.
- Does not restart `stratux.service`.
- If stack is stopped, profile is persisted and marked pending; apply occurs on next `stack/start` (unless user requests immediate start).
- For Custom profile: validates that assignments don't have duplicate roles and that assigned role count doesn't exceed device count.

### `POST /setSdrConfig`

Applies requested SDR role/ppm mapping.

Request supports optional target profile scope:

```json
{
  "profile": "US",
  "applyMode": "live",
  "configs": [
    {
      "deviceKey": "rtl:...",
      "desiredRole": "1090",
      "desiredPPM": -37,
      "enabled": true
    }
  ]
}
```

Semantics:

- If `profile` is omitted, defaults to `ActiveRegionProfile`.
- If `profile != ActiveRegionProfile`, persist only (unless `applyMode` explicitly requests staged + activate).

Request:

```json
{
  "applyMode": "live",
  "configs": [
    {
      "deviceKey": "rtl:...",
      "desiredRole": "1090",
      "desiredPPM": -37,
      "enabled": true
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "warnings": [],
  "applied": ["rtl:..."],
  "failed": []
}
```

Behavior:

- Validate for duplicate role assignments where disallowed.
- Quiesce only affected SDR workers.
- EEPROM update if serial change is required.
- Trigger SDR re-enumeration/reassignment.

### `POST /sdr/startCalibration`

Starts async calibration job.

Request:

```json
{
  "deviceKey": "rtl:...",
  "operation": "ppmAuto",
  "args": {
    "method": "auto",
    "gain": 47,
    "minSignalDb": -70
  }
}
```

Response:

```json
{
  "jobId": "job-20260218-001",
  "state": "queued"
}
```

Supported operations:

- `ppmAuto` (auto-detect best reference source, scan, measure PPM)
- `ppmScan` (scan for available reference signals without measuring)
- `ppmMeasure` (measure PPM against a specific known frequency)

Calibration methods (used by `ppmAuto` and `ppmScan`):

- `"auto"` — try methods in priority order until one succeeds (default)
- `"atsc"` — scan ATSC digital TV pilot carriers (~470–698 MHz)
- `"noaa"` — scan NOAA weather radio frequencies (162.400–162.550 MHz)
- `"vor"` — measure against a user-specified VOR frequency
- `"rtl_test"` — clock comparison via `rtl_test -p` (no RF reference needed)

`ppmAuto` with explicit method:

```json
{
  "deviceKey": "rtl:...",
  "operation": "ppmAuto",
  "args": {
    "method": "atsc",
    "gain": 47,
    "minSignalDb": -70,
    "maxCandidates": 8
  }
}
```

`ppmMeasure` with known VOR frequency:

```json
{
  "deviceKey": "rtl:...",
  "operation": "ppmMeasure",
  "args": {
    "method": "vor",
    "freqHz": 113900000,
    "gain": 47
  }
}
```

### `POST /sdr/cancelCalibration`

Cancels a running async job by id.

### `WebSocket /terminal`

Opens an interactive root shell session via PTY. This is a persistent WebSocket connection — not a request/response API.

**Connection flow:**

1. Client opens WebSocket to `ws://<host>:<port>/terminal`
2. Server allocates PTY, spawns `/bin/bash` as root
3. Server begins relaying PTY output → WS binary frames
4. Client sends keyboard input as WS text frames
5. Client sends resize events as JSON text frames: `{"type":"resize","cols":80,"rows":24}`
6. Server acknowledges connection with status frame: `{"type":"status","msg":"connected"}`

**Connection rejection (max sessions):**

If maximum concurrent sessions are already active, server sends:

```json
{"type":"status","msg":"rejected","reason":"max_sessions"}
```

Then closes the WebSocket with code `1013` (Try Again Later).

**Idle timeout:**

After 14 minutes of no client input, server sends warning:

```json
{"type":"status","msg":"idle_warning","remainingSec":60}
```

At 15 minutes, server sends:

```json
{"type":"status","msg":"idle_timeout"}
```

Then terminates the PTY and closes the WebSocket.

**Session end:**

When the shell process exits (user types `exit`, or process killed):

```json
{"type":"status","msg":"exited","code":0}
```

WebSocket is closed by server.

---

## Job Execution Model

## Constraints

- Calibration commands need exclusive access to target dongle.
- Avoid blocking HTTP handlers.

## Design

- Single background SDR job manager goroutine.
- Queue jobs FIFO per device key.
- Max one calibration job per SDR; optionally one global job at a time for safety.
- Capture stdout/stderr ring buffer for UI streaming/polling.

Job phases:

1. Validate request and device existence.
2. Stop affected SDR worker(s).
3. Acquire exclusive dongle access.
4. Execute calibration pipeline (scan → select → measure) with timeout.
5. Parse result and propose PPM candidate.
6. Release dongle and restart affected SDR worker(s).
7. Publish final job state.

Timeout defaults:

- `ppmScan`: 90 s
- `ppmMeasure`: 45 s
- `ppmAuto`: 180 s (scan + measure combined)
- `writeSerial`: 20 s
- `rtl_test`: 600 s (needs several minutes to stabilize)

Stack interaction rules:

- Calibration and EEPROM jobs require Data Plane to be in `stopped` or per-device quiesced mode.
- `stack/stop` drains or cancels active calibration jobs unless marked `continueWhenStopped` (default false).

### PPM auto-config algorithm (`ppmAuto`)

Goal: zero-configuration PPM calibration from the web UI. No GSM dependency — GSM850 was decommissioned in the US and GSM coverage is unreliable in many areas worldwide.

#### Why not `kal` / kalibrate-rtl?

`kalibrate-rtl` relies on GSM base station broadcast channels (BCCH) as frequency references. With GSM850 shut down in the US (and GSM networks increasingly decommissioned globally), `kal` can no longer find usable reference signals in many locations. The Stratux image currently builds `kal` from source (`steve-m/kalibrate-rtl`), but it should be considered deprecated for new calibration workflows.

#### Calibration Reference Sources (priority order)

**1. ATSC Digital TV Pilots (best precision, US)**

ATSC 1.0 digital TV signals contain a pilot carrier at a precisely known frequency — exactly +309.441 kHz above the lower channel edge. These are ubiquitous, high-power, always-on, and extremely frequency-stable.

- US UHF DTV channels: RF channels 14–36 (post-repack), spanning 470–608 MHz.
- Pilot frequency formula: `pilot_hz = (470_000_000 + (rf_channel - 14) * 6_000_000) + 309_441`
- Scan approach: compute pilot frequencies for all valid RF channels, tune to each briefly, measure received power via FFT, select the strongest.
- PPM measurement: compare measured pilot peak frequency to the known exact frequency. The offset in Hz at the carrier frequency gives PPM: `ppm = (measured_hz - expected_hz) / expected_hz * 1e6`.
- Precision: typically < 1 PPM with a strong signal.

**2. NOAA Weather Radio (quick, moderate precision)**

NOAA Weather Radio stations transmit continuously on 7 fixed frequencies in the 162 MHz band. They are available across the entire US, including rural areas with no TV coverage.

- Known frequencies: 162.400, 162.425, 162.450, 162.475, 162.500, 162.525, 162.550 MHz.
- Scan approach: tune to each frequency, measure received power, select strongest.
- PPM measurement: use NFM demodulation or carrier detection to find center frequency offset.
- Precision: ±2–5 PPM (FM modulation spreads energy, making exact center harder to pinpoint).
- Advantage: works everywhere in the US, even remote areas. No channel database needed.

**3. VOR Stations (aviation-specific, manual)**

VOR stations transmit a continuous carrier on known frequencies (108.00–117.95 MHz). Ideal for aviation users who know their local VOR frequencies.

- User provides VOR frequency (from sectional chart, ForeFlight, etc.).
- Tune to frequency, detect carrier peak via FFT.
- PPM measurement: same offset technique as ATSC.
- Precision: ±1–2 PPM with a strong nearby VOR.
- Note: requires user input (frequency). Not suitable for fully automated scan.

**4. `rtl_test -p` (no RF dependency, lower precision)**

Compares the RTL-SDR's internal clock against the host system's clock. No RF signal needed.

- Command: `rtl_test -p -d <device_index>`
- Requires 5–10 minutes of runtime for cumulative PPM to stabilize.
- Precision: ±5–10 PPM (depends on system clock accuracy).
- Advantage: works anywhere, no antenna needed. Good fallback.
- Caveat: assumes Pi system clock is accurate (NTP or GPS-disciplined clock).

#### `ppmAuto` Pipeline (method = "auto")

1. **Try ATSC scan** (RF channels 14–36):
   - Compute all valid pilot frequencies.
   - Tune to each for ~2s, run 1024-point FFT, measure power at expected pilot offset.
   - If any pilot found above `minSignalDb` threshold → select strongest → proceed to measure.
2. **If no ATSC found, try NOAA scan** (7 frequencies):
   - Tune to each NOAA frequency for ~2s.
   - If any signal found above threshold → select strongest → proceed to measure.
3. **If no NOAA found, fall back to `rtl_test -p`:**
   - Run `rtl_test -p` for configurable duration (default 300s).
   - Parse cumulative PPM from output.
4. **Return `proposedPpm`** in job result (not auto-applied unless user confirms).

Method-specific pipelines (`method = "atsc"`, `"noaa"`, etc.) skip directly to the specified step.

#### Signal Quality Classes

- **Strong**: dB >= -50 (ATSC) / dB >= -40 (NOAA)
- **OK**: -70 <= dB < -50 (ATSC) / -60 <= dB < -40 (NOAA)
- **Weak**: dB < -70 (ATSC) / dB < -60 (NOAA)

#### If no candidate passes threshold:

- If `rtl_test` fallback is enabled (default yes): run it and return with reduced confidence.
- If all methods exhausted: mark job as failed with reason `no_usable_signals`.
- Include all scanned frequencies and their signal levels in output for troubleshooting.

#### Implementation Notes

- ATSC/NOAA scanning can be implemented natively in Go using `gortlsdr` (ReadSync + FFT), avoiding external tool dependencies.
- `rtl_test` is already installed as part of the rtl-sdr package.
- `kal` remains installed on the image for backward compatibility but is not used by new workflows.
- Future: EU users could add DAB+ as a calibration source (similar pilot concept). DAB support is a non-goal for this phase.
- The Pi's GPS-disciplined clock (when GPS is locked) makes `rtl_test` more reliable than on a desktop — worth noting in the UI.

---

## UI/UX Specification (Settings Page)

Add an **SDR Management** section in Settings.

Add a **Stratux Runtime** section:

- Status badge: `Running`, `Stopped`, `Starting`, `Stopping`, `Error`.
- Primary action button:
  - `Stop Stratux Data Plane` when running
  - `Start Stratux Data Plane` when stopped
- Secondary info text:
  - Running: "Traffic/weather receivers active."
  - Stopped: "Receivers paused; WebUI is still available."

Add a **Profile** selector at top of SDR Management:

- Control: segmented selector `US | EU | Custom`.
- Action button: `Apply Profile Now`.
- Info text (US/EU): "Each region has independent SDR mapping. Switching applies that region's saved profile."
- Info text (Custom): "Custom profile lets you assign any protocol to any dongle."
- Optional toggle: `Edit inactive profile` (advanced), enabling profile edits without live apply.

When Custom is selected:

- Each SDR card shows a protocol dropdown with all available roles: `978 (UAT)`, `1090 (ES)`, `868 (OGN)`, `162 (AIS)`, `Disabled`.
- User picks desired protocol per dongle, then clicks `Apply Profile Now`.
- Validation warnings appear inline if duplicate roles are selected or if no 1090 is assigned.
- The Custom profile is fully persisted and survives reboot just like US/EU profiles.

## SDR Inventory Card (per dongle)

Fields:

- Dongle label (`SDR A`, `SDR B`, index)
- Serial (raw)
- Current assigned protocol
- Current role tag (`978/1090/868/162/auto`)
- Current PPM (parsed/effective)
- Runtime state badge (`running/stopped/error`)
- Last error (if present)

Controls:

- Desired role dropdown (Custom profile): `978 (UAT)`, `1090 (ES)`, `868 (OGN)`, `162 (AIS)`, `Disabled`
- Desired role display (US/EU profile): shows assigned role from profile preset (read-only unless editing Custom)
- Desired PPM numeric input (optional)
- `Apply` button per row

## Calibration Panel (per dongle)

Controls:

- `Auto Calibrate PPM` button (primary action, uses auto method)
- Calibration method selector (advanced): `Auto`, `ATSC TV`, `NOAA Weather`, `VOR`, `rtl_test`
- VOR frequency input (shown only when VOR method selected)
- Gain slider (default 47)
- `Apply Measured PPM` button (shown after successful calibration)
- `Cancel Job` button (shown during active calibration)

Output:

- Job state + progress
- Method used + signal source details
- Structured results panel for `ppmAuto`:
  - "Scanning for reference signals..."
  - Method being tried: "Trying ATSC TV pilots..."
  - Incremental discovered signals
  - "Found signals:" table with source, frequency, signal dB, quality
  - Selected best reference and proposed PPM

Example UI readout (ATSC method):

```text
Scanning for reference signals...
Method: ATSC Digital TV Pilots

Scanning RF channels 14-36...
Found signals:
  Ch 24 (533.309 MHz) - -38 dB (Strong)
  Ch 28 (557.309 MHz) - -52 dB (OK)
  Ch 32 (581.309 MHz) - -71 dB (Weak)

Selected: Ch 24 pilot at 533.309441 MHz
Measured offset: +14.2 Hz
Proposed PPM correction: -27
Confidence: High (strong ATSC pilot)
```

Example UI readout (NOAA fallback):

```text
Scanning for reference signals...
Method: ATSC Digital TV Pilots
  No ATSC signals found above threshold.

Falling back to: NOAA Weather Radio
Scanning 7 NOAA frequencies...
Found signals:
  162.400 MHz - -35 dB (Strong)
  162.550 MHz - -58 dB (OK)

Selected: 162.400 MHz
Measured offset: +82.3 Hz
Proposed PPM correction: -508
Confidence: Moderate (NOAA FM carrier)
```

Example UI readout (rtl_test fallback):

```text
Scanning for reference signals...
Method: ATSC Digital TV Pilots
  No ATSC signals found above threshold.
Falling back to: NOAA Weather Radio
  No NOAA signals found above threshold.
Falling back to: rtl_test clock comparison

Running rtl_test -p (this takes several minutes)...
Elapsed: 312s
Cumulative PPM: 54
Proposed PPM correction: 54
Confidence: Low (system clock reference)
```


### Job output payload extensions (for richer UI)

`GET /getSdrJob` may include:

```json
{
  "jobId": "job-20260218-ppmauto-01",
  "state": "running",
  "stage": "scan|select|measure|done",
  "methodsTried": ["atsc"],
  "activeMethod": "atsc",
  "scannedSignals": [
    {"method": "atsc", "label": "Ch 24", "freqMHz": 533.309441, "signalDb": -38, "quality": "Strong"},
    {"method": "atsc", "label": "Ch 28", "freqMHz": 557.309441, "signalDb": -52, "quality": "OK"},
    {"method": "atsc", "label": "Ch 32", "freqMHz": 581.309441, "signalDb": -71, "quality": "Weak"}
  ],
  "selectedSignal": {"method": "atsc", "label": "Ch 24", "freqMHz": 533.309441, "signalDb": -38},
  "measuredOffsetHz": 14.2,
  "proposedPpm": -27,
  "confidence": "high",
  "outputTail": ["..."]
}
```

Confidence values:

- `"high"` — ATSC or VOR pilot with strong signal (recommended for auto-apply)
- `"moderate"` — NOAA carrier or weaker ATSC/VOR signal
- `"low"` — `rtl_test` clock comparison or very weak RF signal
- `"none"` — no usable reference found

## WebUI Terminal (UI)

Add a **Terminal** navigation item in the web UI top bar (alongside Status, Traffic, Weather, Settings, etc.).

Terminal page layout:

- Full-viewport xterm.js terminal canvas (dark theme, monospace font)
- Top toolbar:
  - Connection indicator: green dot = connected, red dot = disconnected
  - `Reconnect` button (visible when disconnected)
  - `Clear` button (clears scrollback buffer)
  - Font size selector: `S | M | L` (12px / 14px / 16px)
- Bottom status bar:
  - Session info: `root@stratux:~#` (informational, actual prompt comes from shell)
  - Idle timeout countdown (shows remaining time when < 5 minutes)
  - `Close Session` button (sends `exit` + closes WS)

Behavior:

- Terminal opens with a login banner: `Stratux WebUI Terminal — Type 'exit' to close session`
- Shell is `/bin/bash` with full `$PATH` including `/usr/local/bin` (where `sdr-tool.sh`, `kal`, etc. live)
- Working directory starts at `/root` (or `$STRATUX_HOME`)
- Full ANSI color support, cursor keys, tab completion, history — all handled by xterm.js + bash
- Copy/paste: Ctrl+Shift+C / Ctrl+Shift+V (or right-click context menu)
- Scrollback buffer: 5000 lines (configurable in xterm.js options)
- Mobile: functional but not optimized (on-screen keyboard works with xterm.js)

Example session:

```
Stratux WebUI Terminal — Type 'exit' to close session
root@stratux:~# sdrs
Found 2 device(s):
  0: Realtek, RTL2838, SN: stratux:978
  1: Realtek, RTL2838, SN: stratux:1090
root@stratux:~# sdr-tool.sh
...
root@stratux:~# rtl_test -p -d 0
...
root@stratux:~# dmesg | tail
...
root@stratux:~# exit
[Session closed]
```

---

## Guardrails in UI

- Confirmation modal before EEPROM writes.
- Warning banner for duplicate role assignments.
- Warning if user enables more protocols than available receivers.
- Warning if switching region would disable currently active weather source (e.g. UAT->OGN) and require user confirmation.

## Operator Workflow (UI)

This section defines expected user interaction flows so frontend and backend behavior remain aligned.

### 0) Start/Stop stack workflow (WebUI stays alive)

Stop flow:

1. User clicks `Stop Stratux Data Plane`.
2. Confirmation modal appears:
  - Title: `Stop Background Services?`
  - Body: "This pauses SDR/GPS/traffic processing but keeps WebUI available."
3. On confirm, UI calls `POST /stack/stop` and shows `Stopping...`.
4. Backend stops Data Plane components in safe order:
  - stop calibration/apply jobs (or cancel)
  - stop SDR readers/watchers and child processes
  - stop traffic ingestion loops
5. UI transitions to `Stopped` and enables `Start Stratux Data Plane`.

Start flow:

1. User clicks `Start Stratux Data Plane`.
2. UI calls `POST /stack/start`.
3. Backend starts Data Plane with active profile/settings.
4. UI shows `Starting...` then `Running` when healthy.

Behavioral guarantees:

- WebUI and settings endpoints remain reachable during stop/start transitions.
- `shutdown`/`reboot` actions still perform full system operations.

### A) Profile switching workflow (US / EU / Custom)

Preconditions:

- SDR Management section is visible.
- Current active profile and runtime SDR state are loaded.

Steps:

1. User selects target profile in segmented control (`US`, `EU`, or `Custom`).
2. UI shows profile preview diff before apply:
  - Example (US→EU): `SDR A: 978 -> 868`, `SDR B: 1090 -> 1090 (unchanged)`.
  - Example (US→Custom): `SDR A: 978 -> 978 (unchanged)`, `SDR B: 1090 -> 868`.
3. For Custom profile:
  - SDR cards become editable — user picks protocol per dongle from dropdown.
  - Inline validation: warns if duplicate roles selected, or if no 1090 assigned.
  - User configures desired assignments, then clicks `Apply Profile Now`.
4. For US/EU profiles:
  - Assignments are preset. User clicks `Apply Profile Now` directly.
5. Confirmation modal appears:
  - Title: `Switch Profile?`
  - Body includes warnings (weather source change, temporary receiver interruption, ~1s gap).
  - Buttons: `Cancel`, `Apply`.
6. On `Apply`, UI disables controls and shows progress:
  - `Persisting profile...`
  - `Reconfiguring receivers...`
7. On success:
  - Show toast: `Profile switched to Custom` (or US/EU).
  - Refresh runtime cards.
8. On failure:
  - Keep previous active profile selected.
  - Show inline error with failed SDR and reason.

If stack is currently `Stopped`:

- `Apply Profile Now` persists profile/mapping only.
- UI shows: `Profile saved. Changes will take effect when Stratux Data Plane starts.`

Expected runtime impact:

- All receivers briefly restart (~1 second gap) due to sdrWatcher() full-rebuild behavior.
- Management UI remains connected. No service restart.

### A.1) Custom profile editing workflow

This workflow is used when the Custom profile is already active and the user wants to change assignments.

1. User is already on Custom profile.
2. User changes protocol dropdown on one or more SDR cards.
3. Changed cards show `Unsaved changes` badge.
4. User clicks `Apply Profile Now`.
5. Validation runs:
   - Error (blocking): duplicate role assigned to two dongles.
   - Warning (non-blocking): no 1090ES assigned, user may lose ADS-B traffic.
   - Warning (non-blocking): 978 assigned without 1090 — UAT weather works but no ADS-B ES.
6. On apply: protocol enablement booleans derived from assignments, sdrWatcher() reconfigures.
7. Updated Custom profile is persisted to `SdrRegionProfiles["Custom"]`.

### B) Per-SDR role/PPM edit workflow

Steps:

1. User edits one SDR row (role and/or PPM).
2. Row enters `dirty` state with local badge: `Unsaved changes`.
3. User clicks row `Apply`.
4. Confirmation modal shown only if EEPROM write is required.
5. UI shows row-scoped progress (`Applying...`).
6. On success:
  - Row clears dirty state.
  - Runtime state updates.
7. On failure:
  - Dirty state stays.
  - Row error details shown with `Retry` action.

### C) PPM auto-config workflow (single SDR)

Steps:

1. User clicks `Auto Calibrate PPM`.
2. Modal `PPM Auto Calibrate` opens with inputs:
  - Method selector (default `Auto`): `Auto`, `ATSC TV`, `NOAA Weather`, `VOR`, `rtl_test`
  - Gain (default `47`)
  - VOR frequency input (visible only if VOR selected)
  - Minimum signal threshold (default `-70 dB`)
  - Checkbox: `Auto-apply result when confidence is high` (default off)
3. User clicks `Start`.
4. If stack is `Running`, UI either:
  - requests per-device quiesce (preferred), or
  - asks user to stop Data Plane first (fallback policy).
5. UI launches async `ppmAuto` job and switches panel to live progress.

Live stages (Auto method):

- `Stage 1: Scanning ATSC TV pilots (channels 14-36)...`
- Incremental updates as channels are scanned
- If ATSC found: `Found 3 ATSC pilots. Selecting strongest...`
- If no ATSC: `No ATSC signals found. Trying NOAA Weather Radio...`
- NOAA scan: `Scanning 7 NOAA frequencies...`
- If no NOAA: `No NOAA signals found. Falling back to rtl_test...`
- rtl_test: `Running rtl_test (estimated 5 minutes)... Elapsed: 47s`
- `Stage 2: Measuring PPM offset on Ch 24 (533.309 MHz)...`
- `Stage 3: Computing correction...`

Completion:

- Show summary card:
  - Method used
  - Reference signal (e.g., "ATSC Ch 24 pilot at 533.309 MHz")
  - Signal strength + quality class
  - Measured frequency offset in Hz
  - Proposed PPM
  - Confidence level (High / Moderate / Low)
- If auto-apply unchecked:
  - Primary action: `Apply Measured PPM`
  - Secondary: `Discard`
- If auto-apply checked and confidence is `high`:
  - Apply automatically, then show `Applied PPM: <value> (ATSC pilot, high confidence)`.
- If auto-apply checked but confidence is only `moderate` or `low`:
  - Do not auto-apply. Show: `PPM measured but confidence too low for auto-apply. Review and apply manually.`

Cancellation:

- User can click `Cancel Job` during any scan/measure stage.
- UI shows `Canceled by user` and restarts any stopped worker.

### D) Error handling workflow

Common user-visible errors and handling:

- `no_usable_signals`:
  - Message: `No usable reference signals found with any method.`
  - Suggested actions: try a different location, connect antenna, use VOR method with a known frequency, or manually enter PPM.
- `device_busy`:
  - Message: `SDR is busy with another operation.`
  - Action: wait or cancel running job.
- `binary_missing`:
  - Message: `Required tool (rtl_test) not installed on this system image.`
  - Action: provide system-level remediation note. Note: ATSC/NOAA/VOR scanning uses built-in Go code and has no external binary dependency.
- `apply_partial_failure`:
  - Message includes succeeded/failed SDR list.
  - Action: `Retry failed` button.
- `stack_transition_failed`:
  - Message: `Could not complete start/stop transition.`
  - Action: show component error details and `Retry`.

### E) Suggested frontend state machine

Per SDR card states:

- `idle`
- `dirty`
- `applying`
- `running`
- `error`

Per calibration job states:

- `queued`
- `running(scan)`
- `running(select)`
- `running(measure)`
- `success`
- `failed`
- `canceled`

Frontend polling/subscription behavior:

- Poll `getSdrJob` every 1s while job is active.
- Poll `getSdrState` every 2s during apply/switch operations.
- Return to normal status refresh interval after completion.

---

## Apply Orchestration (Detailed)

When `setSdrConfig` is called:

1. Snapshot current SDR runtime inventory.
2. Validate requested config:
   - role values valid
   - no duplicate prohibited roles
   - device key exists
3. Build operation plan per device:
   - no-op if already matching
   - EEPROM rewrite needed if role/PPM changed
4. For each affected dongle:
   - stop corresponding worker
   - wait for release confirmation
   - run EEPROM write command
   - verify by re-read
5. Trigger controlled re-enumeration (existing watcher-compatible path).
6. Return applied/failed list and warnings.

When `setRegionProfile` with `applyNow=true` is called:

1. Persist `ActiveRegionProfile`.
2. Load profile-specific SDR config from `SdrRegionProfiles[ActiveRegionProfile]`.
3. Run same apply planner/orchestrator (no service restart).
4. Recompute protocol enablement from selected profile (migration mode: keep compatibility booleans synced).
5. Return apply result.

Rollback behavior:

- If write fails, leave old runtime assignment and report failed item.
- If partial success, still return success=false with per-device result details.

---

## Failure-State Matrix

| Scenario | Detection | User-facing Result | Automatic Recovery |
|---|---|---|---|
| Duplicate role assigned to two SDRs | pre-apply validation | block apply with actionable error | none |
| Target SDR disappears during apply | device re-scan mismatch | failed device with retry hint | periodic re-scan |
| EEPROM write command fails | non-zero exit / stderr parse | failed device + output tail | restart stopped workers |
| Calibration timeout | job timeout | job marked failed(timeout) | restart workers |
| Calibration binary missing | exec error (rtl_test) | failed(precondition) | none; show install hint |
| Auto-PPM found no usable signals | all methods exhausted | failed(no_usable_signals) + show all scanned frequencies | none; user retries with antenna/location change or manual VOR entry |
| Stack stop fails due to stuck child process | stop timeout | stack state `error` + details | force-kill policy + retry |
| Stack start fails due to missing device/resource | startup probe failure | stack state `error` + details | user fixes hardware; retry start |
| Too many protocols enabled for receiver count | existing `sdrconfig` warning path | warning banner in status/settings | user disables extra protocols |
| SDR worker fails to restart | runtime state error | row badge error + details | watcher retry loop |
| Management UI restart request during active job | job manager receives shutdown | graceful cancel + state persisted as canceled | none |
| Custom profile with no 1090 assigned | profile validation | non-blocking warning: "No ADS-B ES receiver configured" | none; user's choice |
| Custom profile applied with missing dongle | device count < assigned count at apply time | partial apply + warning for unmatched devices | apply when dongle inserted (sdrWatcher re-scan) |
| Terminal WS connection dropped | WS close/error event | "Disconnected" overlay + reconnect button | auto-reconnect with exponential backoff (1s → 2s → 4s → max 30s) |
| Terminal PTY process exits | PTY read returns EOF | "Session ended" message in terminal + reconnect option | none; user reconnects for new session |
| Terminal idle timeout reached | 15-min inactivity timer | Warning at T-60s, session killed with message | user reconnects for new session |
| Terminal max sessions exceeded | session counter check | "Maximum terminal sessions active" error on connect | user closes existing session first |
| Terminal command hangs system | N/A (user responsibility) | terminal remains responsive (PTY buffering) | user sends Ctrl+C or closes session |

---

## Backward Compatibility

- Keep existing `/setSettings` keys and behavior unchanged.
- Keep existing Region modal (`US/EU`) for now; internally route it to `setRegionProfile`.
- Preserve legacy serial formats and regex parsing behavior.

Migration path for existing installs:

1. On first startup with new feature, generate `US`, `EU`, and empty `Custom` profiles from current live config.
2. Set `ActiveRegionProfile` using existing `RegionSelected` if available (`0/1=US`, `2=EU`). No existing installs will have Custom.
3. Continue honoring existing region APIs during deprecation window.
4. Custom profile starts empty; user must explicitly configure it before activating.
5. `RegionSelected` int mapping extended: `3=Custom`.

Legacy runtime controls:

- Existing `restart` endpoint can remain as full process restart behavior.
- New stack control endpoints are additive and should be labeled clearly as "WebUI-only start/stop of receivers".

### Legacy serial-role format migration

Existing deployments may use serials like `stratux:978` and `stratux:1090`.

Migration recommendation:

1. Detect legacy role-encoded serials.
2. Keep them functional initially (no forced rewrite).
3. Offer optional one-time migration to neutral identity labels (e.g. `stx:dev:A`, `stx:dev:B`) in UI.
4. After migration, role comes only from profile assignment, not from serial semantics.

Important:

- Do **not** rewrite serial role values on every region switch.
- Runtime role switching must happen in software orchestration.

---

## Security & Safety Notes

- Restrict calibration/EEPROM commands to fixed allowlisted binaries and arguments (`rtl_test`, `rtl_eeprom`).
- ATSC/NOAA/VOR scanning uses `gortlsdr` directly (no shell commands), eliminating injection risk.
- Sanitize all command args (no shell interpolation).
- Require explicit confirmation for EEPROM writes.
- Rate-limit job creation to avoid resource starvation.
- **WebUI Terminal security model:**
  - The terminal provides **full root shell access** — same privilege level as SSH. This is intentional: Stratux runs as root, the WiFi AP is an isolated network (192.168.10.1/24), and the same trust model applies to all WebUI endpoints (no auth currently exists for any route).
  - Terminal sessions are limited to `2` concurrent connections to prevent resource exhaustion from accidental tab duplication.
  - Idle timeout (`15 min`) automatically kills abandoned sessions to reclaim PTY/process resources.
  - If authentication is added to the WebUI in the future, the `/terminal` endpoint MUST be gated behind it with the highest privilege level.
  - The terminal does NOT use `exec.Command` with string interpolation — it allocates a real PTY and relays raw bytes, so there is no injection vector from the WebSocket framing layer itself.

---

## Testing Strategy

## Unit tests

- serial parse/format (`stx:*` + legacy variants)
- role conflict validator
- apply planner
- job lifecycle transitions

## Integration tests (hardware-in-loop preferred)

- two RTL dongles with swapped USB ports across reboot
- per-dongle role reassignment without restarting service
- calibration job while web UI stays reachable
- error injection: unplug SDR during operation
- Custom profile: assign 978+868 to two dongles, verify both receivers start
- Custom profile: switch from US to Custom to EU and back, verify correct protocols active each time
- Custom profile: assign duplicate role (e.g. two 978), verify validation rejects it

## Terminal tests

- PTY allocation succeeds on arm64 (Raspberry Pi) and x86
- WebSocket connect → shell prompt appears within 1 second
- Keyboard input relayed correctly (special keys: arrows, Ctrl+C, Tab, Enter)
- Terminal resize events update PTY dimensions (`stty size` reflects new values)
- Idle timeout fires after configured interval, session closes cleanly
- Max session limit enforced — third connection rejected with `max_sessions`
- Shell `exit` command closes PTY, server sends `exited` status, WS closes
- WS disconnect sends SIGHUP to bash process group (no orphan processes)
- Running `sdr-tool.sh`, `sdrs`, `rtl_test -p`, `kal` all work from terminal
- Service restart (`systemctl restart stratux`) gracefully terminates all terminal sessions
- Long-running output (e.g. `rtl_test -p` continuous mode) streams without buffering lag

## Manual regression checklist

- Existing UAT/ES traffic paths still functional
- OGN/AIS modes still functional
- Region modal still works as before
- Existing settings persistence unaffected
- Custom profile: 978+868 combo receives both UAT and OGN data
- Custom profile: single dongle with non-default protocol (e.g. 868 only) works
- Profile round-trip: US → Custom → EU → US preserves each profile's saved config
- WebUI Terminal: open terminal, run `sdrs`, verify output matches connected dongles
- WebUI Terminal: open terminal, run `sdr-tool.sh`, verify interactive prompts work
- WebUI Terminal: verify Ctrl+C interrupts running command
- WebUI Terminal: close browser tab, verify no orphan bash processes (`ps aux | grep bash`)

---

## Phased Delivery Plan

### Phase 1: Inventory + Read-only UI

- Add `/getSdrState`
- Show per-dongle state in Settings

### Phase 2: Role/PPM apply

- Add `/setSdrConfig`
- Implement safe in-process apply orchestration

### Phase 3: Calibration jobs

- Implement ATSC pilot scanner and NOAA scanner using `gortlsdr` + FFT in Go
- Add `rtl_test -p` fallback wrapper
- Add VOR manual-frequency measurement
- Add async job manager and calibration endpoints (`ppmAuto`, `ppmScan`, `ppmMeasure`)
- Add UI calibration panel with method selector and live progress
- Deprecate `kalibrate-rtl` dependency (keep installed but unused by new code)

### Phase 4: Region profiles + hot switch

- Add durable Settings selector for `US/EU/Custom`
- Add `SdrRegionProfiles` persistence (including Custom)
- Implement live `setRegionProfile` apply flow with protocol enablement derivation
- Add Custom profile UI with per-dongle protocol dropdown and inline validation
- Bridge existing Status region modal to new API

### Phase 5: Data Plane start/stop with persistent WebUI

- Introduce stack state machine (`running|stopped|starting|stopping|error`)
- Add `/getStackState`, `/stack/start`, `/stack/stop`
- Add Settings UI runtime controls and state indicator
- Integrate region/calibration workflows with stopped/running stack semantics

### Phase 6: WebUI Terminal

- Add `github.com/creack/pty` dependency; promote `github.com/gorilla/websocket` to direct
- Implement `/terminal` WebSocket endpoint with PTY relay in `managementinterface.go`
- Add session manager (max sessions, idle timeout, graceful shutdown)
- Vendor xterm.js + addons into `web/plates/js/`
- Create `terminal.html` page with Angular route and xterm.js integration
- Add Terminal nav item to web UI top bar
- Test on Raspberry Pi (arm64) and x86 dev environments
- Document trust model and security considerations

---

## Open Questions

1. Should duplicate `1090` role be allowed for diversity/backup use-cases, or strictly one per protocol?
2. Do we want to support multi-step calibration wizard (scan -> choose channel -> measure -> apply) in one guided flow now or later?
3. Should calibration jobs survive process restart (persist to disk), or be best-effort in-memory only?
4. ~~Should profile switch automatically apply protocol booleans (`UAT_Enabled`/`OGN_Enabled`) even if user previously overrode them manually?~~ **Resolved:** Yes — protocol enablement is always derived from the active profile's SDR assignments (see Protocol Enablement Derivation). Manual `setSettings` overrides of individual `*_Enabled` flags are still honored but will be overwritten on the next profile apply.
5. Should `stack/stop` also pause GPS/AHRS by default, or only SDR/traffic pipelines?
6. Should Custom profile assignments be validated against detected hardware at save time (blocking if SDR not present), or only at apply time (allowing pre-configuration before dongles are plugged in)?
7. Should switching away from Custom profile to US/EU warn if the Custom config will be lost, or always preserve it for later re-activation?

---

## Suggested Initial Defaults

- Keep current behavior for existing users unless they open SDR Management and apply explicit mapping.
- If explicit mappings exist, disable anonymous fallback assignment for those mapped devices.
- Show prominent warning when any active device is anonymous (`idSet=false`).
