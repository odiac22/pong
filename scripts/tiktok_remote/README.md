# Pong TikTok Remote — 30.38.4 integration and recovery

## Latest continuation, 2026-09-29

The web UI is edge-to-edge with translucent floating Pong / Back / Face swap /
Original / Close controls. Center and native bottom navigation remain touchable.
This does not mean every Recall control (including manual Detect) is integrated.

30.38.4 fixes duplicate Original requests, stale in-flight face requests after
reconnect, and historical transformed-frame counts used for current clip status.
The staged backend avoids an extra full-screen RGB copy; pixel equality and
ownership/lifetime tests pass. No resolution/model/restoration settings changed.
Local discovery reloads rotated credentials only for the same AVD and ports;
missing/ambiguous/unauthenticated sources fail closed. It does not launch emulators.

Validation: **45 Python tests and 7 client lifecycle tests pass**. The earlier
30.38.3 receiver displayed native 1080x2340 video and real swaps. Performance did
not qualify: different feed clips showed roughly 10.25 and 16.13 presented FPS;
the latter had 9 decoder drops and one 1.071-second freeze over about 10 seconds.
These are not controlled before/after measurements. Touch-to-visible and first
presented swapped-frame latency remain unmeasured. A test-only H264 attempt found
no matching face; it does not qualify swap performance or change production codec.

The source emulator stopped during testing and was restored silently with app
data preserved. The administrator-owned service still runs 30.38.2 with its old
source credentials. **30.38.4 backend activation is pending** through
`scripts/activate-tiktok-integrated.ps1` in Administrator PowerShell. Read-only
preflight could not verify the elevated process from this agent. No alternate
termination/restart bypass was attempted. Rerun live benchmarks after activation.

The benchmark separates functional success from performance qualification,
records unqualified no-face samples, and closes remote sessions after failures.

## Previous 30.38.2 integration notes (historical)

The setup form is replaced by a full-height remote surface and compact Pong
Back / Face swap / Original / Close controls. Face swap opens the existing Pong
approved-face picker; selection is routed to the remote session, not the paused
Recall card. Token entry, manual region marking and diagnostic tables are absent
from the normal UI. The native APK's small Home/VPS connection badge is unchanged.

One-time, locally authorized device provisioning uses
`scripts/pair-pong-remote-device.mjs`; the scoped remote key is persisted in the
Pong origin's localStorage, never printed. Ordinary use does not require phone
ADB. Opening remote mode auto-connects; foreground/network recovery uses bounded
backoff. Backgrounding releases the controller and foregrounding reconnects.
Clearing Pong app storage requires pairing again. No anonymous LAN bootstrap or
renderer/emulator-key exposure was added.

Automatic video-region selection reads the source app's accessibility layout,
excludes the action/avatar rail and top tabs, and refuses unknown/profile layouts.
Navigation revalidation is asynchronous to input ACKs. The native dump can take
several seconds; **this is not a subsecond navigation/swap qualification**.

Validation: 40 Python remote tests, 8 gateway authentication tests, 5 JavaScript
client lifecycle tests, and actual receiver UI checks (picker visible/hittable,
no token/region form, close restores Pong). At delivery the renderer/preset were
unchanged (GPEN1024 strength100), but remote sidecar activation was still blocked
for the agent. The old sidecar reports30.38; the new UI explicitly asks for the
update rather than pretending a live swap succeeded. Manual activation entry:
`scripts/activate-tiktok-integrated.ps1`. Actual newly integrated live swapping
must still be tested after activation.

## Historical 30.38 candidate

30.38 adds a bounded control mailbox that coalesces only adjacent, valid,
increasing-sequence MOVE events. DOWN/UP/CANCEL/keys keep order; overflow still
disconnects safely. Coalesced moves are reported separately, not counted as
successful input acknowledgements. The client updates timing statistics at
most four times per second while sending input immediately. Offline remote
tests now total 32; these changes are **not live-performance-qualified**.
Latest work and outstanding gates: [30.38 audit](<E:/Pong Benchmarks/v3038-detect/REPORT.md>).

## Historical status: live 30.38 integration, performance qualification incomplete

The user manually activated the helper, renderer and Remote sidecar. The panel
route returns 200, renderer and sidecar report 30.38, and the renderer is ready.
The actual Pong Android APK in a separate hidden, silent receiver emulator has
connected to the signed-in TikTok source emulator, displayed swapped frames and
sent 15 real swipe gestures. **This is not a passed 15-video performance gate.**

In the guarded run, first receiver decoded readiness was 1165 ms. Eleven swipe
windows recorded PC swap completion, ten below one second; median was 148 ms
and the slowest was 2753 ms. Four other checkpoints showed scenery or an update
promotion, and one checkpoint was a photo. They are not 15 eligible moving-face
clips. Input RPC acknowledgement median was 27 ms, not touch-to-visible latency.
An earlier run was invalidated by a native TikTok ANR; restarting only that app
restored operation without changing its login. Actual native screenshots were
used because WebView screenshots omitted the hardware video layer.

Detailed results, failed gates and staged Recall changes:
[receiver and Recall live audit](<E:/Pong Benchmarks/v3038-detect/RECEIVER-AND-RECALL-LIVE.md>).

The panel checks availability before suspending ordinary Pong playback. It uses
an approved-face picker and a user-confirmed video region, not the whole app UI.
Vertical feed swipes reset tracking; taps/profile/back navigation suspend swaps.
Rendering has one in-flight frame and one replaceable pending capture, separate
from the input queue. Slow rendering cannot create an ever-growing frame FIFO.
This architecture has offline and actual receiver tests, but no 15-video
sub-second presentation qualification.

All API calls require the local pairing key; the renderer bridge uses a separate
key. Keys are generated once in the ignored cache directory without printing
their values. Never use a TikTok password as a pairing key. No login credentials
were read. Native gRPC remains authenticated and loopback-only.

The 30.37 audit includes 28 remote regressions, 3 remote-client lifecycle tests,
and 327 total counted automated
tests. Three actual ten-second native capture runs kept TikTok in the foreground:
29.978 / 30.003 / 30.047 whole-window FPS at 1080×2340, first captured frame
43.8 / 35.9 / 22.5 ms. The roughly 1 ms read-only RPC is **not** touch-to-visible
latency. An earlier probe captured Pong after TikTok crashed and is excluded.

Neither phone-visible swapped TikTok latency nor final WebRTC image quality is qualified.
`firstSwappedFrameMs` measures PC render completion, not phone presentation.
The interface explicitly labels the transport experimental. GPEN1024 strength
100 and the complete production quality configuration remain unchanged.

Full current evidence and outstanding gates:
[30.37 audit](<E:/Pong Benchmarks/v3037-flow-audit/REPORT.md>).
Manual isolated-component launch handoff:
`../start-overnight-audit-v3037.ps1` (not run by the agent).
Starting that script alone does not reload the production helper/renderer.
After the native capture measurements, the emulator TikTok app was stopped to
avoid background feed resource consumption. Login/app data remain intact. The
app must be reopened silently before the next live capture test.

## Historical prototype 30.31-prototype.3 notes

The remainder records the earlier prototype. Deployment and integration status
below is historical; the current status above supersedes it.

### Earlier status, 2026-09-28

**Partial implementation. Not deployed, not connected to Pong's TikTok button,
and not a completed TikTok or face-swap latency benchmark.** Existing Pong UI,
APK, helper and face-swap services/presets were not changed or restarted.

Implemented in an isolated directory:

- Real WebRTC video transport and a reliable, ordered input data channel.
- Native-resolution emulator RGB capture via its gRPC controller, using bindings
  generated from this PC's installed Android SDK proto.
- Touch down/move/up/cancel and a Back control. No shell command execution API.
- Local receiver UI with millisecond median/p95 counters and silent video only.
- Bounded queues, coalesced pointer movement, stale sequence rejection, one
  controller at a time, touch release on disconnect and a heartbeat watchdog.
- Mandatory pairing token, same-origin API checks, no-store responses and no
  access logging. HTTP binds loopback; the emulator must use authenticated
  loopback gRPC. Phone deployment still needs an authenticated HTTPS route.

Not implemented/validated yet:

- Full TikTok gesture/orientation calibration, profile-navigation timing, and
  comparisons with the user's signed-in Edge PWA.
- Integration of the renderer with continuous screen capture and a video-only
  region. Face swapping is explicitly marked unavailable, not silently simulated.
- Pong button integration, a phone-visible deployment, or next-video preparation.
- Real input-to-screen latency, first-swapped-frame latency, native presentation
  FPS, dropped-frame/quality measurements, or signed-in cold/warm comparisons.

## Execution blocker

Update: the user manually started the authenticated emulator, and we verified
that `127.0.0.1:8556` rejects unauthenticated requests and accepts the correct
token. Android finished booting. APK installation succeeded, and the user
completed login manually. The scrcpy login mirror was closed at the user's
request; the emulator remains running headlessly with audio disabled. The
earlier launch denial below was not retried by the agent.

The existing `pong_benchmark_api35` emulator was booted headlessly and silently
on ADB port 5580. Its explicit gRPC port initially bound without authentication.
That **test instance was shut down** using its exact ADB serial. A subsequent
launch requesting `-grpc-use-token` was rejected by this session's execution
policy. It was not retried through another command, process, agent, or UI.

Do not restore unauthenticated control to get past the blocker. Do not claim
that successful synthetic transport tests are measurements of the emulator.

## Downloaded official app

- Source: the full TikTok APK link embedded in `https://www.tiktok.com/download`.
- Artifact: `E:\Pong Benchmarks\tiktok-remote\TikTok-official.apk`
- Package: `com.zhiliaoapp.musically`
- Version in this official download: **38.3.3**, code **2023803030**. This is not a
  claim that it is the newest Play Store version.
- Size: 429,047,484 bytes.
- SHA-256: `ab8d9394d87ca046bda8f49031791cfaf75588a0830b5d54766e1bcf8ccdd6bc`
- Signer certificate SHA-256:
  `9041803e91bcb814b4b4399fb5c85a91640b755e5e8ba76813814bf4cf2ab5ba`
- `apksigner verify --print-certs` used on the downloaded file.
- APK has ARM64/ARMv7 libraries. Installed AVD is x86_64 and supports arm64-v8a
  through `libndk_translation.so`. The app now runs; the user completed login.
- **Installed and login user-confirmed.** The agent did not read the user's
  credential note, enter credentials, or record the login screen.

## Runtime and verification

Dependencies are isolated under `E:\Pong Benchmarks\tiktok-remote\deps` rather
than installed into the production swap virtual environment. The isolated
WebRTC runtime contains aiortc 1.15.0 and PyAV 17.1.0; it is not the qualified
production rendering environment. Generated controller bindings are under
`E:\Pong Benchmarks\tiktok-remote\bindings` and are not committed source.

The follow-up runtime check confirmed the required dependencies are present. Direct
runtime dependency versions are recorded in `requirements.txt`; both emulator
binding modules import successfully. No further library installation was needed.
That initial device check preceded the user's successful manual emulator startup.

From the Pong repository, the tested command is:

```powershell
$env:PYTHONPATH = 'E:\Pong Benchmarks\tiktok-remote\deps'
& '.\Pong Swap\runtime\venv\Scripts\python.exe' -m unittest discover -s scripts/tiktok_remote -v
```

Result: **22 tests passed**, including a real local WebRTC negotiation, received
synthetic video frame, ping, touch delivery, second-controller rejection, and
release of a held touch on disconnect. Tests use `FakeEmulator`; they do not
contact TikTok, play audio, start an emulator or modify user presets.

The prototype.2 review also serialized controller admission and disconnect,
made repeated cleanup wait for in-flight touch release, rejected malformed offer
data, and fixed browser shutdown recursion when its input buffer overflows.
Receiver JavaScript syntax validation passed.

Prototype.3 removes two full-resolution RGB copies for immutable capture
buffers, retains defensive copies for mutable buffers, and adds pixel/lifetime
regressions. Static screens now receive display-only keepalives so the decoder
does not wait indefinitely for more motion before displaying its first frame.
Keepalives are counted separately from captured and fresh-submitted frames.
The static-screen regression failed with a timeout before the fix and passes now.
Cleanup now completes in a shielded task even if its original caller is cancelled;
cancelled negotiation also closes its session. Tests cover cancellation and three
sequential connections. One earlier live probe stalled for an undetermined reason;
a later instrumented three-run probe completed. Do not claim the stall is resolved.

See `LIVE_BASELINE.md` for the first real signed-in emulator transport results.
These are local capture/WebRTC measurements, not phone glass-to-glass latency,
source-video FPS, or fresh face-swap inference FPS. No swap settings changed.

## Timing definitions

| Field | What it actually measures |
|---|---|
| `networkRoundTripMs` | Receiver data-channel ping to server and back |
| `inputAckMs` | Receiver send to acknowledgement after emulator RPC completion |
| `emulatorRpcAcknowledgement` | Server's elapsed time awaiting the emulator RPC, not app rendering |
| `inputQueue` | Time waiting in the server's bounded control queue |
| `captureToEncoderSubmission` | Receipt of captured pixels until submission to WebRTC's encoder |
| `presentedFrameIntervalMs` | Browser video-frame callback intervals, not an input-response measurement |
| `visibleResponseMs` | Currently null; needs causal screen-change/physical-display validation |
| `firstSwappedFrameMs` | First PC swap completion in the current scene; not receiver presentation or necessarily fresh inference |

For further qualification, validate full-screen
orientation and touch mapping on a harmless calibration screen. Measure actual
visible responses using a known on-screen change correlated with input, and
verify against high-speed input/display recording when possible. A receipt ACK
or the next video frame alone must never count as a successful UI response.

The unchanged-quality swapper is attached in the live 30.38 flow. Continue to
use the same full-quality source, keep video/UI regions separate, reset identity
history on navigation/cuts, and measure additional latency. Revalidate encoding
quality; aiortc defaults are not automatically equivalent to Pong's quality
baseline. Never label dropped capture frames as fresh inference frames.

The user should enter their TikTok password directly in the app, not in chat or
the pairing-token field. Do not log keyboard content, credentials, or screen
captures of login forms. Login/onboarding prompts require user handoff.
