import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.MOCK_PI_RPC_VERSION ?? "pi 1.0.0"}\n`);
  process.exit(0);
}

if (process.env.MOCK_PI_RPC_ARGS_FILE) {
  fs.writeFileSync(process.env.MOCK_PI_RPC_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}

if (process.env.MOCK_PI_RPC_PRELUDE) {
  process.stdout.write(`\u001b[32m${process.env.MOCK_PI_RPC_PRELUDE}\u001b[0m\n`);
}

if (process.env.MOCK_PI_RPC_EXIT_ON_START === "1") {
  fs.writeSync(2, "mock startup failure\n");
  process.exit(7);
}

const ignoreCommand = process.env.MOCK_PI_RPC_IGNORE_COMMAND;
const failCommand = process.env.MOCK_PI_RPC_FAIL_COMMAND;
const exitCommand = process.env.MOCK_PI_RPC_EXIT_ON_COMMAND;
const noIdCommand = process.env.MOCK_PI_RPC_NO_ID_COMMAND;
const staleIdCommand = process.env.MOCK_PI_RPC_STALE_ID_COMMAND;
let staleIdRequest = null;
const extensionUiFile = process.env.MOCK_PI_RPC_EXTENSION_UI_FILE;
const thinkingFile = process.env.MOCK_PI_RPC_THINKING_FILE;
const sessionFile = process.env.MOCK_PI_RPC_SESSION_FILE ?? "/tmp/mock-pi-session.json";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(command, request, data = null, success = true, error = undefined) {
  const message = {
    type: "response",
    command,
    success,
    data,
    ...(error ? { error } : {}),
    ...(request.id && command !== noIdCommand ? { id: request.id } : {}),
  };
  write(message);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.type === ignoreCommand) return;
  if (request.type === exitCommand) {
    fs.writeSync(2, `mock exit on ${request.type}\n`);
    process.exit(9);
  }
  if (request.type === failCommand) {
    response(request.type, request, null, false, `mock failure: ${request.type}`);
    return;
  }

  if (request.type === staleIdCommand) {
    if (!staleIdRequest) {
      staleIdRequest = request;
      return;
    }
    response(request.type, staleIdRequest, { stale: true });
    response(request.type, request, { fresh: true });
    return;
  }

  switch (request.type) {
    case "get_state":
      response("get_state", request, { sessionFile, model: "mock/model" });
      break;
    case "get_available_models":
      response("get_available_models", request, {
        providers:
          process.env.MOCK_PI_RPC_EMPTY_MODELS === "1"
            ? []
            : [{ id: "mock", models: [{ id: "model-a", name: "Model A" }] }],
      });
      break;
    case "get_commands":
      response("get_commands", request, {
        commands: [
          {
            name: "workflow:list",
            description: "List workflow runs",
            source: "extension",
            sourceInfo: {
              path: "/mock/pi/extensions/workflows/index.ts",
              source: "workflows",
              scope: "user",
              origin: "top-level",
              baseDir: "/mock/pi/extensions/workflows",
            },
          },
          {
            name: "commit-message",
            description: "Draft a commit message",
            source: "prompt",
            sourceInfo: {
              path: "/workspace/.pi/prompts/commit-message.md",
              source: "commit-message.md",
              scope: "project",
              origin: "top-level",
              baseDir: "/workspace/.pi/prompts",
            },
          },
          {
            name: "skill:browser-tools",
            description: "Interactive browser automation",
            source: "skill",
            sourceInfo: {
              path: "/mock/pi/skills/browser-tools/SKILL.md",
              source: "browser-tools",
              scope: "user",
              origin: "top-level",
              baseDir: "/mock/pi/skills/browser-tools",
            },
          },
        ],
      });
      break;
    case "prompt":
      write({ type: "assistant_delta", text: "hello" });
      response("prompt", request, { turnId: "turn-mock", sessionFile });
      break;
    case "steer":
      response("steer", request, { ok: true });
      break;
    case "abort":
      response("abort", request, { aborted: true });
      break;
    case "set_model":
      response("set_model", request, { provider: request.provider, modelId: request.modelId });
      break;
    case "set_thinking_level":
      if (thinkingFile) fs.writeFileSync(thinkingFile, JSON.stringify(request));
      response("set_thinking_level", request, { thinkingLevel: request.level, sessionFile });
      break;
    case "get_session_stats":
      response("get_session_stats", request, { tokens: { input: 10, output: 2 } });
      break;
    case "get_messages":
      response("get_messages", request, [{ role: "assistant", content: "hello" }]);
      break;
    case "workflow_control":
      if (process.env.MOCK_PI_RPC_WORKFLOW_UNKNOWN === "1") {
        response("workflow_control", request, null, false, "unknown command: workflow_control");
      } else {
        response("workflow_control", request, { action: request.action, target: request.target });
      }
      break;
    case "extension_ui_response":
      if (extensionUiFile) fs.writeFileSync(extensionUiFile, JSON.stringify(request));
      if (process.env.MOCK_PI_RPC_EXTENSION_UI_NO_RESPONSE !== "1") {
        response("extension_ui_response", request, { received: true });
      }
      break;
    default:
      response(request.type, request, null, false, `unknown command: ${request.type}`);
      break;
  }
});
