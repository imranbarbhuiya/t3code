import {
  ProviderSetupError,
  type ClaudeSetupTokenResult,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";

const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// The lookahead waits for the character after the token so a chunk split mid-token never matches.
const SETUP_TOKEN = /sk-ant-oat\d+-[\w-]{20,}(?=[^\w-])/u;
const APPROVAL_TIMEOUT = Duration.minutes(10);
const OUTPUT_LIMIT = 64_000;

export const readSetupToken = (output: string): string | undefined =>
  output.replace(ANSI_SEQUENCE, "").match(SETUP_TOKEN)?.[0];

const readConfigString = (config: unknown, key: string): string => {
  const value =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value.trim() : "";
};

export class ClaudeSetupToken extends Context.Service<
  ClaudeSetupToken,
  {
    /** Runs `claude setup-token` here, so the browser approval happens on this computer. */
    readonly mint: (
      input: ProviderSetupInput,
    ) => Effect.Effect<ClaudeSetupTokenResult, ProviderSetupError>;
  }
>()("t3/provider/ClaudeSetupToken") {}

export const make = Effect.gen(function* () {
  const pty = yield* PtyAdapter.PtyAdapter;
  const settings = yield* ServerSettings.ServerSettingsService;

  const mint = Effect.fn("ClaudeSetupToken.mint")(function* (input: ProviderSetupInput) {
    const failure = (detail: string, cause?: unknown) =>
      new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "claude-setup-token",
        detail,
        cause,
      });
    const home = yield* HostProcess.HomeDirectory;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => failure("Could not read provider settings.", cause)),
    );
    const instance = current.providerInstances[input.instanceId];
    const config = instance?.driver === "claudeAgent" ? instance.config : undefined;
    const binary = expandHomePath(readConfigString(config, "binaryPath") || "claude", home);
    const configDir = readConfigString(config, "homePath");
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (configDir) env["CLAUDE_CONFIG_DIR"] = expandHomePath(configDir, home);

    return yield* Effect.acquireUseRelease(
      pty
        .spawn({ shell: binary, args: ["setup-token"], cwd: home, cols: 1000, rows: 50, env })
        .pipe(
          Effect.mapError((cause) =>
            failure(`Could not start ${binary}. Check that Claude is installed here.`, cause),
          ),
        ),
      (process) =>
        Effect.callback<ClaudeSetupTokenResult, ProviderSetupError>((resume) => {
          let output = "";
          const stopData = process.onData((chunk) => {
            output = (output + chunk).slice(-OUTPUT_LIMIT);
            const token = readSetupToken(output);
            if (token) resume(Effect.succeed({ token }));
          });
          const stopExit = process.onExit(() =>
            resume(
              Effect.fail(
                failure("Claude stopped before creating a token. Approve it in the browser."),
              ),
            ),
          );
          return Effect.sync(() => {
            stopData();
            stopExit();
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: APPROVAL_TIMEOUT,
            orElse: () => Effect.fail(failure("Timed out waiting for approval in the browser.")),
          }),
        ),
      (process) => Effect.sync(() => process.kill()),
    );
  });

  return ClaudeSetupToken.of({ mint });
});

export const layer = Layer.effect(ClaudeSetupToken, make);
