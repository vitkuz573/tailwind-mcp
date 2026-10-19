/**
 * Protocol smoke test.
 *
 * Speaks the real MCP wire protocol over stdio, exactly as a client would.
 * This catches protocol-level breakage that unit tests cannot see.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { v4Fixture, type Fixture } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "index.js");

interface JsonRpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Run a sequence of JSON-RPC requests against the server over stdio. */
function callServer(
  projectRoot: string,
  requests: { method: string; params?: Record<string, unknown> }[],
): Promise<JsonRpcResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: { ...process.env, TAILWIND_MCP_PROJECT: projectRoot, TAILWIND_MCP_LOG_LEVEL: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const responses: JsonRpcResponse[] = [];
    const pending = new Map<number, (value: JsonRpcResponse) => void>();

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out. Got ${responses.length}/${requests.length} responses.`));
    }, 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        const resolvePending = pending.get(message.id);
        if (resolvePending) {
          pending.delete(message.id);
          resolvePending(message);
        } else if (typeof message.id === "number") {
          responses.push(message);
        }
        if (responses.length + pending.size >= requests.length) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(responses);
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (responses.length + pending.size < requests.length) {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code}). stderr:\n${stderr}`));
      }
    });

    requests.forEach((request, index) => {
      const id = index + 1;
      const promise = new Promise<JsonRpcResponse>((resolveOne) => {
        pending.set(id, resolveOne);
      });
      promise.then((response) => {
        responses.push(response);
        if (responses.length >= requests.length) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(responses);
        }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: request.method, params: request.params ?? {} })}\n`,
      );
    });
  });
}

describe("MCP protocol", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await v4Fixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("lists tools and validates a class", async () => {
    const responses = await callServer(fixture.root, [
      {
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { method: "tools/list" },
      {
        method: "tools/call",
        params: { name: "tailwind_validate", arguments: { candidates: ["p-4", "p-nope"] } },
      },
    ]);

    const initialize = responses.find((r) => r.id === 1);
    expect(initialize?.error).toBeUndefined();
    expect(initialize?.result?.serverInfo).toBeTruthy();

    const list = responses.find((r) => r.id === 2);
    const tools = (list?.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "tailwind_canonicalize",
      "tailwind_conflicts",
      "tailwind_contrast",
      "tailwind_diagnose",
      "tailwind_migrate",
      "tailwind_search_classes",
      "tailwind_theme",
      "tailwind_validate",
      "tailwind_variants",
    ]);

    const call = responses.find((r) => r.id === 3);
    expect(call?.error).toBeUndefined();
    const structured = call?.result?.structuredContent as
      { valid: string[]; invalid: { candidate: string }[] } | undefined;
    expect(structured?.valid).toEqual(["p-4"]);
    expect(structured?.invalid.map((entry) => entry.candidate)).toEqual(["p-nope"]);
  });
});
