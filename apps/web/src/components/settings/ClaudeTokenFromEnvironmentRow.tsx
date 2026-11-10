import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { nextProviderEnvironmentWithFieldValue } from "./ProviderInstanceCard";
import { SettingsRow } from "./settingsLayout";

const DEFAULT_CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const TOKEN_FIELD = { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude token", sensitive: true };

/** Signs a remote Claude instance in with a token minted by `claude setup-token` on another environment. */
export function ClaudeTokenFromEnvironmentRow(props: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined;
  readonly onEnvironmentChange: (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => void;
}) {
  const hasToken = (props.environment ?? []).some((variable) => variable.name === TOKEN_FIELD.name);
  const mint = useAtomCommand(serverEnvironment.mintClaudeSetupToken, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setPending(true);
    setError(null);
    const result = await mint({
      environmentId: props.sourceEnvironmentId,
      input: { instanceId: DEFAULT_CLAUDE_INSTANCE },
    });
    setPending(false);
    if (result._tag === "Success") {
      props.onEnvironmentChange(
        nextProviderEnvironmentWithFieldValue(props.environment, TOKEN_FIELD, result.value.token),
      );
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not create a Claude token.");
  };

  return (
    <SettingsRow
      title={`Use Claude from ${props.sourceLabel}`}
      description={
        error ??
        (pending
          ? `Approve the request in ${props.sourceLabel}'s browser.`
          : hasToken
            ? "Signed in with a Claude token. Sign in again to replace it, or clear Claude token below."
            : `Sign in through ${props.sourceLabel}'s browser. No login needed on this machine.`)
      }
      control={
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void signIn()}>
          {pending ? "Waiting…" : hasToken ? "Sign in again" : "Sign in"}
        </Button>
      }
    />
  );
}
