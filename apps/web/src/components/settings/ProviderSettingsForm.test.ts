import { describe, expect, it } from "vite-plus/test";
import { CustomAcpSettings, PiSettings, ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE, PROVIDER_CLIENT_DEFINITIONS } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
    ]);
  });

  it("exposes Pi and Custom ACP as active provider definitions", () => {
    const activeValues = PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value);

    expect(activeValues).toContain(ProviderDriverKind.make("pi"));
    expect(activeValues).toContain(ProviderDriverKind.make("customAcp"));
    expect(activeValues).not.toContain(ProviderDriverKind.make("grok"));
    expect(activeValues).not.toContain(ProviderDriverKind.make("acpRegistry"));

    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];
    expect(pi).toBeDefined();
    expect(pi).toMatchObject({ label: "Pi", settingsSchema: PiSettings });

    const customAcp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("customAcp")];
    expect(customAcp).toBeDefined();
    expect(customAcp).toMatchObject({ label: "Custom ACP", settingsSchema: CustomAcpSettings });
  });

  it("derives the minimal Pi settings surface", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];

    expect(pi).toBeDefined();
    expect(deriveProviderSettingsFields(pi!).map((field) => field.key)).toEqual(["binaryPath"]);
  });

  it("creates and edits native Pi provider config with only binaryPath", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];
    expect(pi).toBeDefined();
    const binaryPath = deriveProviderSettingsFields(pi!).find(
      (field) => field.key === "binaryPath",
    );
    expect(binaryPath).toBeDefined();

    const created = nextProviderConfigWithFieldValue(undefined, binaryPath!, "pi");
    const edited = nextProviderConfigWithFieldValue(created, binaryPath!, "C:/tools/pi.cmd");
    const cleared = nextProviderConfigWithFieldValue(edited, binaryPath!, "");

    expect(created).toEqual({ binaryPath: "pi" });
    expect(edited).toEqual({ binaryPath: "C:/tools/pi.cmd" });
    expect(cleared).toBeUndefined();
  });

  it("derives the Custom ACP settings surface", () => {
    const customAcp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("customAcp")];

    expect(customAcp).toBeDefined();
    const fields = deriveProviderSettingsFields(customAcp!);
    expect(fields.map((field) => field.key)).toEqual([
      "command",
      "args",
      "env",
      "authMethodId",
      "askQuestionEnabled",
      "askQuestionMethod",
      "manualModels",
      "clientCapabilitiesMetaJson",
    ]);
    expect(fields.find((field) => field.key === "args")).toMatchObject({
      control: "textarea",
      label: "Arguments",
    });
    expect(fields.find((field) => field.key === "askQuestionEnabled")).toMatchObject({
      control: "switch",
      defaultBooleanValue: true,
    });
  });

  it("edits Custom ACP provider config without changing native Pi semantics", () => {
    const customAcp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("customAcp")];
    expect(customAcp).toBeDefined();
    const fields = deriveProviderSettingsFields(customAcp!);
    const command = fields.find((field) => field.key === "command");
    const askQuestionEnabled = fields.find((field) => field.key === "askQuestionEnabled");
    expect(command).toBeDefined();
    expect(askQuestionEnabled).toBeDefined();

    const withCommand = nextProviderConfigWithFieldValue(undefined, command!, "pi");
    const disabledAskQuestion = nextProviderConfigWithFieldValue(
      withCommand,
      askQuestionEnabled!,
      false,
    );
    const defaultAskQuestionCleared = nextProviderConfigWithFieldValue(
      disabledAskQuestion,
      askQuestionEnabled!,
      true,
    );

    expect(withCommand).toEqual({ command: "pi" });
    expect(disabledAskQuestion).toEqual({ command: "pi", askQuestionEnabled: false });
    expect(defaultAskQuestionCleared).toEqual({ command: "pi" });
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
