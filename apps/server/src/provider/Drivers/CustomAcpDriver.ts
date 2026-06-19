import { CustomAcpSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { makeCustomAcpTextGeneration } from "../../textGeneration/CustomAcpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGenericAcpAdapter } from "../Layers/GenericAcpAdapter.ts";
import {
  buildInitialCustomAcpProviderSnapshot,
  checkCustomAcpProviderStatus,
} from "../Layers/CustomAcpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const decodeCustomAcpSettings = Schema.decodeSync(CustomAcpSettings);
const DRIVER_KIND = ProviderDriverKind.make("customAcp");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type CustomAcpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CustomAcpDriver: ProviderDriver<CustomAcpSettings, CustomAcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Custom ACP",
    supportsMultipleInstances: true,
  },
  configSchema: CustomAcpSettings,
  defaultConfig: (): CustomAcpSettings => decodeCustomAcpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CustomAcpSettings;
      // Phase 1 stores ACP slash commands at provider-instance scope. If multiple cwd-specific sessions report different commands, the latest session update wins.
      const slashCommandsRef = yield* Ref.make<Option.Option<ServerProvider["slashCommands"]>>(
        Option.none(),
      );
      const slashCommandsPubSub = yield* PubSub.unbounded<ServerProvider["slashCommands"]>();
      const updateSlashCommands = (commands: ServerProvider["slashCommands"]) =>
        Ref.set(slashCommandsRef, Option.some(commands)).pipe(
          Effect.andThen(PubSub.publish(slashCommandsPubSub, commands)),
          Effect.asVoid,
        );

      const adapter = yield* makeGenericAcpAdapter(effectiveConfig, {
        provider: DRIVER_KIND,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onSlashCommandsUpdated: updateSlashCommands,
      });
      const textGeneration = yield* makeCustomAcpTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkCustomAcpProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.flatMap((snapshot) =>
          Ref.get(slashCommandsRef).pipe(
            Effect.map((cached) =>
              Option.isSome(cached) ? { ...snapshot, slashCommands: cached.value } : snapshot,
            ),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<CustomAcpSettings>({
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialCustomAcpProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ getSnapshot, publishSnapshot }) => {
          const publishCommands = (slashCommands: ServerProvider["slashCommands"]) =>
            getSnapshot.pipe(
              Effect.flatMap((current) => publishSnapshot({ ...current, slashCommands })),
            );
          return Ref.get(slashCommandsRef).pipe(
            Effect.flatMap((slashCommands) =>
              Option.isSome(slashCommands) ? publishCommands(slashCommands.value) : Effect.void,
            ),
            Effect.andThen(
              Stream.runForEach(Stream.fromPubSub(slashCommandsPubSub), publishCommands),
            ),
          );
        },
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Custom ACP snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
