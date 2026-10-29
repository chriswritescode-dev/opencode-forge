# OpenCode Compatibility

**Verdict: compatible as-is with OpenCode 2.2.0.** No Forge source change was required for this release.

Forge declares a floor of OpenCode `>=2.0.14` (`engines.opencode`) and is verified against the newest release at the time of writing, `2.2.0`. The floor is a range, not a pin: a host on `2.0.x` keeps working, but only `2.2.0` carries the evidence recorded here.

`VERIFIED_OPENCODE_VERSION` in `src/constants/plugin.ts` is the single source of truth for the verified version. `test/constants/plugin.test.ts` fails when it drifts from the `@opencode/plugin` and `@opencode/client` pins, from the `README.md` claim, or from this document.

## Pins

| Package | Pin | Why |
| --- | --- | --- |
| `@opencode/plugin` | `2.2.0` (dependency) | Types for `define`, `Plugin.Context`, `shell.hook`, TUI slots and keymaps. |
| `@opencode/client` | `2.2.0` (devDependency) | `V2Event` union consumed by `src/host/v2-events.ts`. |
| `@opentui/core` | `0.7.0` (devDependency) | Renderer the host provides to TUI plugins. |
| `@opentui/solid` | `0.7.0` (devDependency) | JSX runtime for `src/tui.tsx`. |
| `engines.opencode` | `>=2.0.14` | Supported floor, deliberately a range. |
| `peerDependencies` on `@opentui/*` | `>=0.1.105` | Published range, deliberately looser than the dev pin. |

`@opencode/plugin@2.2.0` declares optional peers on `@opentui/core` and `@opentui/solid` pinned exactly to `0.7.0`. Because they are optional peers, the looser published `>=0.1.105` range still installs; the TUI surface is only verified at `0.7.0`, which is what the host ships.

## Verified surfaces

| Surface | What was checked | Evidence | Result |
| --- | --- | --- | --- |
| Server plugin API (`src/index.ts`, `src/host/v2.ts`) | `define` from `@opencode/plugin/promise/plugin`, plugin init through `setupForgeV2`, process-wide tool registration (`registerForgeToolsV2`), `shell.hook('create.before')` typing | `pnpm build` + load probe: `msg="loading plugin"` for `opencode-forge.js`, five Forge agents in `opencode debug agents`, `forge.db` created, no `level=ERROR`/`level=WARN` | Pass |
| Event stream (`src/host/v2-events.ts`) | Whether 2.2.0 publishes `session.status` / `session.idle`, and whether `session.execution.*` still brackets a turn | Event probe: **0** `session.status` and **0** `session.idle` events; `session.execution.started` and `session.execution.succeeded` once per run | Pass — the existing drops in `normalizeV2Event` are still required |
| Per-location delivery (`createV2SessionOwnership`) | Whether a location's plugin instance still receives another location's session events | Two locations in one server: the `proj` instance received `session.execution.started`/`succeeded` for the session created in the `wt` worktree | Pass — per-location filtering is still required |
| TUI plugin (`src/tui.tsx`, `@opentui` 0.7.0 provided by the host) | `cli.json` directory entry resolution and TUI plugin setup | TUI load probe: palette search for `sandbox` lists "Toggle sandbox" and "Build sandbox template" in group `Forge`; no error naming forge, `@opentui`, or `solid` | Pass (load only; see *Not verified*) |
| RPC (`FORGE_RPC`, `src/client/v2-workspaces.ts`) | `Plugin.Context` RPC/workspace types used by the TUI client | `pnpm typecheck` against `@opencode/plugin@2.2.0`; types only, no runtime contract | Pass |
| Client types (`@opencode/client` `V2Event`) | Event union and `location` shape used by normalization and ownership | `pnpm typecheck`; event probe confirmed every observed type is in the union | Pass |
| Dashboard | Independent of the OpenCode version; no `@opencode/*` runtime import | `pnpm test --project dom test/dashboard/app-dom.test.ts` | Pass |
| Sandbox (`msb`) | Not exercised by these probes | `msb` runtime only; `pnpm test` covers the TypeScript facade | Not exercised |

## Reproducing the probes

All probes run outside the repository. Command-line `--standalone` keeps every server private to the probe, and an isolated `HOME`/XDG tree keeps the real profile untouched.

```bash
export PROBE=$(mktemp -d)
export HOME=$PROBE/home \
       XDG_CONFIG_HOME=$PROBE/config \
       XDG_DATA_HOME=$PROBE/data \
       XDG_STATE_HOME=$PROBE/state \
       XDG_CACHE_HOME=$PROBE/cache
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
```

Scratch repositories need a root commit (`git commit --allow-empty`), otherwise OpenCode cannot derive a project:

```bash
git -c user.email=probe@example.com -c user.name=probe commit --allow-empty -m init
```

### Probe 1 — CLI binary

```bash
mkdir -p "$PROBE/cli" && cd "$PROBE/cli"
curl -sSL -o cli.tgz https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.2.0.tgz
tar xzf cli.tgz          # use @opencode/cli-linux-arm64 on arm64
./package/bin/opencode --version   # opencode v2.2.0
export BIN=$PROBE/cli/package/bin/opencode
```

Result: `opencode v2.2.0`.

### Probe 2 — server plugin load

```bash
pnpm build && pnpm run setup --link -y      # run in the Forge checkout
mkdir -p "$PROBE/proj" && cd "$PROBE/proj" && git init -q
git -c user.email=probe@example.com -c user.name=probe commit --allow-empty -qm init
$BIN debug agents --standalone
```

The installer writes `<XDG_CONFIG_HOME>/opencode/plugin/opencode-forge.js` and the `cli.json` TUI entry pointing at the checkout's `dist`.

Results:

- `debug agents --standalone` returned 12 agents, including `architect`, `architect-auto`, `auditor`, `auditor-loop` and `code`.
- `<XDG_DATA_HOME>/opencode/forge/forge.db` exists.
- `<XDG_DATA_HOME>/opencode/log/opencode.log` contains `msg="loading plugin" id=…/plugin/opencode-forge.js … role=server` and no `level=ERROR` or `level=WARN` line.

### Probe 3 — TUI plugin load

```bash
sudo apt-get install -y tmux
tmux new-session -d -s oc -x 200 -y 50 "$BIN --standalone $PROBE/proj"
sleep 20
tmux send-keys -t oc C-p
sleep 3
tmux send-keys -t oc "sandbox"
sleep 3
tmux capture-pane -p -t oc
tmux kill-session -t oc
```

Result: the palette search lists Forge's commands, which only exist when the TUI plugin's `setup` ran:

```text
Commands                                                                     esc
sandbox
Toggle sandbox        Run this session's agent shell, …            Forge
Build sandbox template Build the sandbox template image and …      Forge
```

The TUI surface writes no `loading plugin` line for `cli.json` entries at the default log level, so the palette is the load evidence for this surface. No log line mentions forge, `@opentui`, or `solid` as an error.

### Probe 4 — event stream with a fake provider

A separate profile, without Forge, records OpenCode's own event stream so the result describes the host, not Forge's reaction to it.

```bash
export HOME=$PROBE/ev/home \
       XDG_CONFIG_HOME=$PROBE/ev/config \
       XDG_DATA_HOME=$PROBE/ev/data \
       XDG_STATE_HOME=$PROBE/ev/state \
       XDG_CACHE_HOME=$PROBE/ev/cache
mkdir -p "$HOME" "$XDG_CONFIG_HOME/opencode/plugin" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
```

`$PROBE/ev/stub.py`:

```python
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[1]


def log(line):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log("%s %s" % (self.command, self.path))

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json({"object": "list", "data": [{"id": "m", "object": "model"}]})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        log("POST %s %s" % (self.path, raw[:400]))
        if not self.path.startswith("/v1/chat/completions"):
            self._json({})
            return
        request = json.loads(raw) if raw else {}
        model = request.get("model", "m")
        if not request.get("stream", False):
            self._json({
                "id": "chatcmpl-probe",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True
        chunks = [
            {
                "id": "chatcmpl-probe",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": "pong"}, "finish_reason": None}],
            },
            {
                "id": "chatcmpl-probe",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


ThreadingHTTPServer(("127.0.0.1", 18765), Handler).serve_forever()
```

`<XDG_CONFIG_HOME>/opencode/opencode.json`:

```json
{
  "provider": {
    "stub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Stub",
      "options": { "baseURL": "http://127.0.0.1:18765/v1", "apiKey": "x" },
      "models": { "m": { "name": "m" } }
    }
  },
  "model": "stub/m"
}
```

`<XDG_CONFIG_HOME>/opencode/plugin/event-probe.js` (replace `<PROBE>` with the absolute value of `$PROBE` when writing the file; the path must be absolute so both plugin copies write to one file):

```javascript
const LOG = '<PROBE>/ev/events.log'

export default {
  id: 'event-probe',
  setup: async (ctx) => {
    const { appendFileSync } = await import('node:fs')
    const write = (line) => appendFileSync(LOG, JSON.stringify(line) + '\n')
    void (async () => {
      for await (const e of ctx.event.subscribe({})) {
        write({ instance: ctx.location?.directory, type: e.type, sid: e.data?.sessionID ?? e.properties?.sessionID })
      }
    })()
    return () => {}
  },
}
```

Run the stub in the background, then the single-location case:

```bash
setsid nohup python3 "$PROBE/ev/stub.py" "$PROBE/ev/stub.log" >/dev/null 2>&1 & echo $! > "$PROBE/ev/stub.pid"
mkdir -p "$PROBE/ev/proj" && cd "$PROBE/ev/proj" && git init -q
git -c user.email=probe@example.com -c user.name=probe commit --allow-empty -qm init
$BIN run --standalone --model stub/m "ping"   # prints pong, exit 0
```

Two locations in one server:

```bash
cd "$PROBE/ev/proj"
$BIN service set port 49911     # non-default so no other service collides
$BIN service start
git worktree add ../wt -q
: > "$PROBE/ev/events.log"      # analyse only the two-location run
$BIN run --model stub/m "ping host"
cd "$PROBE/ev/wt"
$BIN run --model stub/m "ping wt"
$BIN service stop
kill "$(cat "$PROBE/ev/stub.pid")"
```

Analysis of `events.log` (74 lines in the first run and 77 in a review re-run, 2 sessions; the exact count varies):

- `session.status`: **0**. `session.idle`: **0**. Neither type is published by 2.2.0.
- `session.execution.started` and `session.execution.succeeded`: present once per session inside its own location, **twice** for the worktree session because both plugin instances received it.
- Cross-location delivery: the `proj` instance recorded `session.execution.started` and `session.execution.succeeded` for the session created in the `wt` location, and every other session-scoped event for it too. `createV2SessionOwnership` in `src/host/v2-events.ts` is what turns that into a single owner, so it remains required.

Both runs printed `pong` and exited 0.

A review re-run on 2026-10-29 reproduced probes 1–4 with the same results.

## Not verified

These need a real model or `msb` and remain owner manual checks:

- A full plan loop with sections: phase transitions, coder/auditor sessions, section audit, final audit, teardown commit and worktree removal.
- Patch-loop execution.
- Sandbox start, `exec`, and network policy.
- TUI sidebar rendering with live loops (only plugin load and palette commands were checked; the sidebar needs a loop row to render).

## Follow-ups

None. No Forge defect surfaced on OpenCode 2.2.0, so the probe run made no source change.
