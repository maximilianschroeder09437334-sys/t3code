import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Only the flags under test reach the config, so local env files and build credentials stay out.
const CONFIG_ENV_KEYS = [
  "APP_VARIANT",
  "T3CODE_IOS_PERSONAL_TEAM",
  "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
  "T3CODE_MAXI_ANDROID",
  "T3CODE_MOBILE_UPDATES_ENABLED",
  "T3CODE_MOBILE_VERSION",
] as const;

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      CONFIG_ENV_KEYS.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, env: Partial<Record<string, string>> = {}) {
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) vi.stubEnv(key, env[key]);
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

const MAXI_IOS_ENV = {
  T3CODE_IOS_PERSONAL_TEAM: "1",
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.maximilian.t3code.mobile",
  T3CODE_MOBILE_UPDATES_ENABLED: "0",
};

function pluginNames(config: Awaited<ReturnType<typeof loadConfig>>) {
  return (config.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

function pluginOptions(config: Awaited<ReturnType<typeof loadConfig>>, name: string) {
  const entry = (config.plugins ?? []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === name,
  );
  return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : undefined;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  [{}, "2.3.0"],
  [{ T3CODE_MOBILE_VERSION: "3.0.0" }, "3.0.0"],
])("keeps the ordinary version policy for %j", async (env, version) => {
  const config = await loadConfig("production", env);
  expect(config.version).toBe(version);
  expect(config.ios?.buildNumber).toBeUndefined();
  expect(config.android?.versionCode).toBeUndefined();
  expect(config.updates?.enabled).toBe(true);
  expect(config.scheme).toBe("t3code");
  expect(config.ios?.appleTeamId).toBeDefined();
  expect(pluginNames(config)).toContain("expo-widgets");
});

it.each([
  ["preview", "t3code-preview"],
  ["production", "t3code"],
])("pins the Maxi iPhone and iPad build for APP_VARIANT=%j", async (variant, variantScheme) => {
  // The version override must win over the ordinary env override.
  const config = await loadConfig(variant, { ...MAXI_IOS_ENV, T3CODE_MOBILE_VERSION: "3.0.0" });
  expect(config.name).toBe("T3 Code Maxi");
  expect(config.version).toBe("2.2.6");
  expect(config.ios).toMatchObject({
    bundleIdentifier: "com.maximilian.t3code.mobile",
    buildNumber: "10",
    supportsTablet: true,
  });
  expect(config.android?.versionCode).toBeUndefined();
  expect(config.scheme).toEqual(["t3code-maxi", variantScheme]);
  expect(config.updates?.enabled).toBe(false);
});

it("keeps the Maxi iOS personal-team restrictions", async () => {
  const config = await loadConfig("preview", MAXI_IOS_ENV);
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.ios?.entitlements).toBeUndefined();
  expect(pluginOptions(config, "expo-sharing")?.ios).toMatchObject({ enabled: false });
  expect(pluginOptions(config, "@clerk/expo")).toMatchObject({ appleSignIn: false });
  const names = pluginNames(config);
  expect(names).toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  expect(names).not.toContain("expo-widgets");
  expect(names).not.toContain("./plugins/withShareExtensionDisplayName.cjs");
});

it("pins the Maxi Android build without touching iOS", async () => {
  const config = await loadConfig("production", { T3CODE_MAXI_ANDROID: "1" });
  expect(config.name).toBe("T3 Code Maxi");
  expect(config.version).toBe("2.2.6");
  expect(config.android).toMatchObject({
    package: "com.maximilian.t3code.mobile",
    versionCode: 14,
  });
  expect(config.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
  expect(config.ios?.buildNumber).toBeUndefined();
  expect(config.scheme).toEqual(["t3code-maxi", "t3code"]);
});
