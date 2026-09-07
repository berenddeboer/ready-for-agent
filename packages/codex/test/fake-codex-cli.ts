import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const ASTRA_APP_SERVER_MODEL = {
  model: "gpt-6-astra",
  displayName: "GPT-6 Astra",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
    { reasoningEffort: "xhigh" },
    { reasoningEffort: "max" },
    { reasoningEffort: "ultra" },
  ],
}

export const ZENITH_APP_SERVER_MODEL = {
  model: "gpt-9-zenith",
  displayName: "GPT-9 Zenith",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "spark" }],
}

export const HIDDEN_DAYBREAK_MODEL = {
  model: "gpt-daybreak-blue-latest",
  displayName: "Daybreak Blue",
  hidden: true,
  supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
}

export const DEFAULT_APP_SERVER_PAGES = [
  {
    data: [ASTRA_APP_SERVER_MODEL],
    nextCursor: "page-2",
  },
  {
    data: [ZENITH_APP_SERVER_MODEL],
    nextCursor: null,
  },
]

export const DEFAULT_BUNDLED_MODELS = {
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-daybreak-blue-latest",
      display_name: "Daybreak Blue",
      visibility: "hide",
      supported_in_api: true,
      priority: 2,
      supported_reasoning_levels: [{ effort: "ultra" }],
    },
    {
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 7,
      supported_reasoning_levels: [{ effort: "high" }],
    },
  ],
}

const PYTHON_FAKE = `#!/usr/bin/env python3
import json, os, sys, time
try:
    sys.stdin.reconfigure(line_buffering=True)
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

args = sys.argv[1:]
joined = " ".join(args)
mode = os.environ.get("FAKE_CODEX_MODE", "")
argv_log = os.environ.get("FAKE_ARGV_LOG")
if argv_log:
    with open(argv_log, "a", encoding="utf-8") as handle:
        handle.write(joined + "\\n")

def fail_if_exec():
    if "exec" in args:
        sys.exit(20)

fail_if_exec()

if "login" in args and "status" in args:
    sys.stderr.write(os.environ.get("FAKE_LOGIN", "Logged in using ChatGPT") + "\\n")
    extra = os.environ.get("FAKE_LOGIN_STDERR_EXTRA", "")
    if extra:
        sys.stderr.write(extra + "\\n")
    sys.exit(int(os.environ.get("FAKE_LOGIN_EXIT", "0")))

if "debug" in args and "models" in args:
    if "--bundled" not in args:
        sys.exit(31)
    if os.environ.get("FAKE_BUNDLED_SLEEP"):
        time.sleep(float(os.environ["FAKE_BUNDLED_SLEEP"]))
    sys.stdout.write(os.environ.get("FAKE_BUNDLED_JSON", "{\\"models\\":[]}"))
    sys.stdout.write("\\n")
    extra = os.environ.get("FAKE_BUNDLED_STDERR", "")
    if extra:
        sys.stderr.write(extra + "\\n")
    sys.exit(int(os.environ.get("FAKE_BUNDLED_EXIT", "0")))

if "app-server" not in args:
    sys.stderr.write("unrecognized subcommand\\n")
    sys.exit(21)

if "--listen" not in args or "stdio://" not in joined:
    sys.stderr.write("app-server requires --listen stdio://\\n")
    sys.exit(22)

if mode == "unsupported":
    extra = os.environ.get("FAKE_APP_SERVER_STDERR", "")
    if extra:
        sys.stderr.write(extra + "\\n")
    sys.stderr.write("error: unrecognized subcommand 'app-server'\\n")
    sys.exit(2)

if mode == "hang":
    time.sleep(30)
    sys.exit(0)

pages = json.loads(os.environ.get("FAKE_MODEL_PAGES", "[]"))
initialized = False
page_index = 0
seen_ids = set()

while True:
    raw = sys.stdin.readline()
    if raw == "":
        break
    line = raw.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        sys.stdout.write("not-json\\n")
        sys.stdout.flush()
        continue
    method = msg.get("method")
    req_id = msg.get("id")

    if method == "thread/start" or method == "turn/start" or method == "command/exec":
        sys.exit(40)

    if method == "initialized":
        initialized = True
        continue

    if req_id is None:
        continue

    if os.environ.get("FAKE_NOTIFY_BEFORE") == "1":
        sys.stdout.write(json.dumps({"method": "server/ready"}) + "\\n")
        sys.stdout.flush()

    if method == "initialize":
        if mode == "init-error":
            sys.stdout.write(json.dumps({
                "id": req_id,
                "error": {"code": -32600, "message": "bad initialize"}
            }) + "\\n")
            sys.stdout.flush()
            continue
        sys.stdout.write(json.dumps({
            "id": req_id,
            "result": {"userAgent": "fake", "codexHome": "/tmp"}
        }) + "\\n")
        sys.stdout.flush()
        continue

    if method != "model/list":
        sys.stdout.write(json.dumps({
            "id": req_id,
            "error": {"code": -32601, "message": "Method not found"}
        }) + "\\n")
        sys.stdout.flush()
        continue

    if not initialized:
        sys.stdout.write(json.dumps({
            "id": req_id,
            "error": {"code": -32000, "message": "Not initialized"}
        }) + "\\n")
        sys.stdout.flush()
        continue

    params = msg.get("params") or {}
    if params.get("includeHidden") is True:
        sys.exit(41)

    if mode == "rpc-error":
        sys.stdout.write(json.dumps({
            "id": req_id,
            "error": {"code": -32600, "message": "invalid cursor: invalid"}
        }) + "\\n")
        sys.stdout.flush()
        continue

    if mode == "malformed-result":
        sys.stdout.write(json.dumps({"id": req_id, "result": {"models": []}}) + "\\n")
        sys.stdout.flush()
        continue

    if mode == "empty":
        sys.stdout.write(json.dumps({"id": req_id, "result": {"data": [], "nextCursor": None}}) + "\\n")
        sys.stdout.flush()
        continue

    if mode == "repeat-cursor":
        sys.stdout.write(json.dumps({
            "id": req_id,
            "result": {"data": pages[0]["data"] if pages else [], "nextCursor": "same"}
        }) + "\\n")
        sys.stdout.flush()
        continue

    if mode == "hidden-only":
        hidden = json.loads(os.environ.get("FAKE_HIDDEN_ENTRY", "null"))
        sys.stdout.write(json.dumps({
            "id": req_id,
            "result": {"data": [hidden] if hidden else [], "nextCursor": None}
        }) + "\\n")
        sys.stdout.flush()
        continue

    if page_index >= len(pages):
        sys.stdout.write(json.dumps({
            "id": req_id,
            "result": {"data": [], "nextCursor": None}
        }) + "\\n")
        sys.stdout.flush()
        continue

    page = pages[page_index]
    page_index += 1
    sys.stdout.write(json.dumps({"id": req_id, "result": page}) + "\\n")
    sys.stdout.flush()

sys.exit(0)
`

export const withFakeCodex = async <A>(
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fake-cli-"))
  const path = join(directory, "codex")
  try {
    await writeFile(path, PYTHON_FAKE)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-effect-test-"))
  const path = join(directory, "codex")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
