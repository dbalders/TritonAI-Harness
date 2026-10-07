import {
  accountCommandValue,
  createAccountLoginController,
} from "@t3tools/client-runtime/state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Encoding from "effect/Encoding";
import * as WebBrowser from "expo-web-browser";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNativeAccountLogin } from "./nativeAccountLogin";

function AccountButton({
  title,
  disabled,
  onPress,
}: {
  readonly title: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg border border-border px-3 py-2 disabled:opacity-50"
    >
      <Text className="text-sm text-foreground">{title}</Text>
    </Pressable>
  );
}

export function UcsdAccountSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const preparedConnection = usePreparedConnection(environmentId);
  const getStatus = useAtomCommand(serverEnvironment.getAccountStatus, { reportFailure: false });
  const start = useAtomCommand(serverEnvironment.startAccountLogin, { reportFailure: false });
  const poll = useAtomCommand(serverEnvironment.pollAccountLogin, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutAccount, { reportFailure: false });
  const controller = useMemo(() => {
    const native = createNativeAccountLogin({
      getStatus: async () => accountCommandValue(await getStatus({ environmentId, input: {} })),
      start: async (input) => accountCommandValue(await start({ environmentId, input })),
      poll: async (input) => accountCommandValue(await poll({ environmentId, input })),
      signOut: async () => accountCommandValue(await signOut({ environmentId, input: {} })),
      createReturnUrl: () => {
        const configured = Constants.expoConfig?.scheme;
        const scheme = Array.isArray(configured) ? configured[0] : configured;
        const id = Encoding.encodeBase64Url(Crypto.getRandomBytes(32));
        return `${scheme}:///account/callback/${id}`;
      },
      openAuthSession: async (url, returnUrl) => {
        const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
        return result.type === "success" && "url" in result
          ? { type: "success", url: result.url }
          : { type: "cancel" };
      },
    });
    const controller = createAccountLoginController({
      ...native,
      openExternal: async (url) => {
        await native.openExternal(url);
        await controller.check();
      },
      now: Date.now,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    });
    return controller;
  }, [environmentId, getStatus, poll, signOut, start]);
  const { account, busy, error, checkedAt } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useFocusEffect(
    useCallback(() => {
      if (preparedConnection._tag === "None") return;
      return controller.activate();
    }, [controller, preparedConnection]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void controller.check();
    });
    return () => subscription.remove();
  }, [controller]);
  const pending = account?.status === "pending";
  const signedIn = account?.status === "signed-in";

  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      <Text className="text-base font-t3-bold text-foreground">UC San Diego account</Text>
      <Text className="text-sm text-foreground-muted">
        {account === null
          ? error
            ? "Account status is unavailable."
            : "Checking account availability…"
          : !account.configured
            ? "UC San Diego sign-in is not available on this environment yet."
            : signedIn
              ? `Signed in as ${account.profile?.displayName ?? "UC San Diego account"} · ${account.profile?.email ?? ""}`
              : pending
                ? "Waiting for UC San Diego sign-in…"
                : "Sign in to connect your UC San Diego account to this environment."}
      </Text>
      {account?.expiresAt ? (
        <Text className="text-xs text-foreground-muted">
          {pending ? "Sign-in expires" : "Session expires"}{" "}
          {new Date(account.expiresAt * 1000).toLocaleString()}.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error}
        </Text>
      ) : checkedAt ? (
        <Text className="text-sm text-foreground-muted">
          Connection verified at {new Date(checkedAt).toLocaleTimeString()}.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {account?.configured && !pending && !signedIn ? (
          <AccountButton
            title="Sign in with UC San Diego"
            disabled={busy}
            onPress={() => void controller.signIn()}
          />
        ) : null}
        {pending ? (
          <AccountButton
            title="Reopen browser"
            disabled={busy || !account.verificationUrl}
            onPress={() => void controller.reopenBrowser()}
          />
        ) : null}
        {pending || signedIn ? (
          <AccountButton
            title={pending ? "Cancel" : "Sign out"}
            disabled={busy}
            onPress={() => void controller.signOut()}
          />
        ) : null}
        <AccountButton
          title={
            busy ? "Connecting…" : account?.configured ? "Check connection" : "Check availability"
          }
          disabled={busy}
          onPress={() => void controller.check()}
        />
      </View>
      {account?.configured ? (
        <Text className="text-xs text-foreground-muted">
          This sign-in applies to your connection to this environment.
        </Text>
      ) : null}
    </View>
  );
}
