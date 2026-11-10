import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as ClaudeSetupToken from "./ClaudeSetupToken.ts";

const TOKEN = `sk-ant-oat01-${"Ab3_-x".repeat(16)}`;
const instanceId = ProviderInstanceId.make("claudeAgent");

describe("readSetupToken", () => {
  it("reads the token from Claude's rendered terminal output", () => {
    const output = `\x1b[2K\x1b[1G\x1b[32mYour\x1b[1COAuth\x1b[1Ctoken:\x1b[39m\r\n\x1b[1m${TOKEN}\x1b[22m\r\n\x1b]8;;\x07Store this token securely.`;
    expect(ClaudeSetupToken.readSetupToken(output)).toBe(TOKEN);
  });

  it("waits until the whole token has arrived", () => {
    expect(ClaudeSetupToken.readSetupToken(`token:\r\n${TOKEN.slice(0, 60)}`)).toBeUndefined();
    expect(ClaudeSetupToken.readSetupToken(`token:\r\n${TOKEN}`)).toBeUndefined();
    expect(ClaudeSetupToken.readSetupToken(`token:\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  it("ignores the sign-in prompt before approval", () => {
    expect(
      ClaudeSetupToken.readSetupToken(
        "Browser didn't open? Use the url below to sign in\r\nhttps://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference\r\nPaste code here if prompted >",
      ),
    ).toBeUndefined();
  });
});

const mintWith = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "claude-setup-token-" });
    const binaryPath = path.join(dir, "claude");
    yield* fs.writeFileString(binaryPath, `#!/bin/sh\n${script}\n`);
    yield* fs.chmod(binaryPath, 0o755);
    return yield* Effect.gen(function* () {
      const service = yield* ClaudeSetupToken.ClaudeSetupToken;
      return yield* Effect.result(service.mint({ instanceId }));
    }).pipe(
      Effect.provide(
        Layer.effect(ClaudeSetupToken.ClaudeSetupToken, ClaudeSetupToken.make).pipe(
          Layer.provide(NodePtyAdapter.layer),
          Layer.provide(
            ServerSettings.layerTest({
              providerInstances: {
                [instanceId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { binaryPath, homePath: path.join(dir, "home") },
                },
              },
            }),
          ),
        ),
      ),
      Effect.map((result) => ({ result, dir })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ClaudeSetupToken.mint", () => {
  it.live("returns the token without waiting for Claude to exit", () =>
    Effect.gen(function* () {
      const { result } = yield* mintWith(
        `[ "$1" = setup-token ] || exit 3\ncase "$CLAUDE_CONFIG_DIR" in */home) ;; *) exit 4 ;; esac\nprintf 'Your OAuth token:\\r\\n${TOKEN}\\r\\nStore this token securely.\\r\\n'\nsleep 60`,
      );
      expect(result._tag === "Success" ? result.success.token : result.failure.detail).toBe(TOKEN);
    }),
  );

  it.live("fails when Claude exits before printing a token", () =>
    Effect.gen(function* () {
      const { result } = yield* mintWith("echo 'Login cancelled'; exit 1");
      expect(result._tag === "Failure" ? result.failure.detail : "").toMatch(
        /stopped before creating a token/,
      );
    }),
  );
});
