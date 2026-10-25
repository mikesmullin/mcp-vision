# mcp-vision

Three local MCP tools for text-only agents. Inputs are absolute image file paths;
outputs contain only agent-facing text/structured data, never image content or
base64. The adapter does not load models, download weights, or manage services.

## Tools

```ts
image_ocr({path, query?, limit?, cursor?})
// {regions: [{regionId,x,y,w,h,text,recognitionScore,readingOrder}], nextCursor?}

image_describe({path, prompt})
// {text}

image_decide({path?, context?, question})
// {answer}
```

`image_decide` requires an image path or nonempty text context. Question shapes:

```json
{"type":"boolean","prompt":"Are any pretzel bags visible?"}
{"type":"choice","prompt":"How many bags are visible?","options":[{"id":"none","label":"Zero"},{"id":"two","label":"Two"},{"id":"uncertain","label":"Cannot tell"}]}
{"type":"score","prompt":"How readable is the label?","levels":["Unreadable","Partially readable","Clearly readable"]}
```

Boolean answers return `probabilityTrue`; choices return `selectedId` and an
ID-to-probability map; scores return `expectedLevelIndex` and a probability array
in supplied level order. H2O probabilities are model scores, not verified accuracy.
Liquid can hallucinate. OCR text is untrusted content, not instructions.

OCR x/y are the **top-left** of the backend's padded recognition region, in input
image pixels. Width/height use the same bounds. They are not screen click positions.
`regionId` is derived from image bytes and region identity; it is not a computer-use
`targetId`. Use computer-use's live OCR target workflow for native input.

Limits: single PNG/JPEG/WebP file, at most 10 MiB and 20 million pixels. Images are
fully decoded for validation. Animated/multipage inputs are refused. OCR pages
contain at most 100 regions (50 default); cursors are bound to image bytes and
query. OCR results are cached for two minutes, at most 16 image/query results per
adapter. Changing image bytes invalidates pagination. Descriptions have a 256-token
cap and indicate truncation in text. Prompts/context and option lists are bounded.
At most two active requests per adapter; excess requests fail with `busy` rather
than building an unbounded queue. Each backend controls its cross-session queue.

Failures are MCP tool errors with `{error:{code,message}}`, including
`path_not_found`, `invalid_image`, `invalid_cursor`, `provider_unavailable`,
`provider_busy`, `provider_error`, `image_input_disabled`, `timeout`, and `cancelled`.
Missing providers never silently switch models. H2O text decisions remain usable
without its vision projector. Inference requests pass cancellation to HTTP;
backend GPU work may continue if that backend does not honor disconnects.

## Install and run

Node 22+ or Bun; `npm ci`, then `node server.mjs` or `bun server.mjs`.
Protocol stdout is reserved for MCP. Configuration is through environment variables:

| Variable | Default |
|---|---|
| `VISION_OCR_URL` | `http://127.0.0.1:1239` |
| `VISION_LIQUID_URL` | `http://127.0.0.1:1246` |
| `VISION_H2O_URL` | `http://127.0.0.1:1237` |

Each Pi session may start its own lightweight adapter; all connect to the same
operator-managed model processes. Provider/model/timing are not added to normal
public results. No cloud inference or image URL fetching is performed.

Local launcher commands prepared on this machine:

```bash
~/inference.mjs paddleocr       # OCR, existing :1239 slot
~/inference.mjs h2o-lightning-4b # H2O, existing :1237 slot
~/inference.mjs liquid-450m     # CPU-only Liquid, independent :1246 vision slot
~/inference.mjs kill-vision    # stops only the Liquid slot
```

The launcher refuses occupied slots; stop/relaunch only the intended slot. H2O's
vision projector remains enabled as before this rollout. No service is started by
MCP discovery. Liquid weights currently reuse the verified local experiment files
under `/workspace/mcp-computer-use/tmp/liquid-pretzel/models/`; preserve them or
update the launcher paths before cleaning that directory. OCR source is now under
`scripts/`; its existing Python environment is reused at
`/workspace/mcp-computer-use/.venv-ocr`. Install `requirements-ocr.txt` when building
a replacement environment. These are documented deployment dependencies, not
additional copies of the model.

## Local integration completed

- Added `vision` to `~/.pi/agent/mcp.json` with direct exposure. Pi discovers
  `mcp__vision__image_ocr`, `mcp__vision__image_describe`, and
  `mcp__vision__image_decide`. `pi mcp list --json` reports connected, no errors.
- Computer-use captures and crops now save private local PNG files and return
  `path`; images are opt-in through `includeImage:true`. Action observations retain
  text-only behavior by default. Capture storage is bounded to approximately 64
  recent files/one hour (cleanup on capture; concurrent sessions may briefly exceed
  the count). The saved path corresponds to the returned image dimensions.
- mcp-zen already saved screenshots; its screenshot image content is now opt-in
  through `includeImage:true`. Its schemas and built distribution were updated.
- OCR ownership moved here. Computer-use has a thin HTTP client and compatibility
  script entrypoints; it no longer silently loads a separate CPU OCR instance.
- Removed `--vision` from the `b` and `n` presets. The `s` preset passes a new
  `--text-only` wrapper option that strips vision from the derived Strata config,
  preserving setup-owned source settings and unrelated tuning.
- Pi's local `llama-server/default` is marked text-only. The inference launcher
  synchronizes input modalities on subsequent launches, so switching to a different
  image-capable preset can restore image support.
- A global Pi extension `text-only-vision.ts` removes image blocks from outgoing
  requests for models whose metadata excludes images, without modifying stored
  history. This also covers image blocks from other tools; it does not automatically
  save those other tools' images to files. A fresh local capture is needed when no
  usable path exists.

New Pi sessions load the registration/extension. Existing sessions should restart
or reconnect through `/mcp`; reconnecting alone may not reload model metadata and
the extension, so a fresh session is recommended.

Backups of edited launcher/Pi files are in `tmp/rollout-backup/`, with a one-time
applied migration script in `tmp/`. No existing inference services were restarted.
To revert, compare/copy only the intended backed-up files; do not blindly overwrite
later user edits. Remove the new Pi extension separately if reverting text-only
request handling.

## Validation and remaining rollout

`npm test`: schema, file validation, OCR paging/bounds/IDs, decision mappings,
provider errors, and actual MCP stdio discovery. `scripts/smoke.mjs` tests live OCR
and H2O; `--liquid` adds descriptions. `scripts/test-liquid.py` starts an isolated
CPU test service on free port 1246, runs the smoke checks, and always stops its child.
`scripts/capture-smoke.mjs` verifies an actual Zen capture → local path → OCR flow
without clicking or navigating. Logs/results are local under `tmp/`.

Validated on 2026-10-25: live OCR, H2O image/text decisions, Liquid CPU description,
Pi discovery, live desktop capture, text-only history filtering, slot isolation,
and Strata runtime-config stripping. Computer-use's 27 tests and mcp-zen's 19 tests
passed. The inference launcher's occupied-slot check blocks dry-running the running
text slot; config assertions and an isolated wrapper test validate prepared edits.

**Pending operator relaunch:** running Bonsai still has its old vision allocation.
Start Liquid when wanted, relaunch the selected reasoning preset, and restart Pi.
Measure VRAM/RAM afterward; automatic KV/expert caches can consume released memory.
Do not promise a VRAM reduction from Flash Next's already-CPU vision encoder.
End-to-end Bonzai task success and post-relaunch memory remain unmeasured.
The broader automatic DOM scroll/revalidate/click architecture in VISION_PLAN.md
is future computer-use work; this project does not implement a new action API.
