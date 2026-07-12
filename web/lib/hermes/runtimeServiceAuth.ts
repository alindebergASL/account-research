import { timingSafeEqual } from "node:crypto";

export type RuntimeServiceAuthConfig = {
  nodeEnv: string | undefined;
  runtimeEnabled: boolean;
  fakeMode: boolean;
  serviceToken: string | null;
};

export function runtimeServiceAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeServiceAuthConfig {
  const token = env.HERMES_SERVICE_TOKEN?.trim() ?? "";
  return {
    nodeEnv: env.NODE_ENV,
    runtimeEnabled: env.HERMES_RUNTIME_ENABLED === "1",
    fakeMode: env.HERMES_RUNTIME_FAKE === "1" || env.NODE_ENV !== "production",
    serviceToken: token || null,
  };
}

export function assertRuntimeServiceAuthConfigured(config: RuntimeServiceAuthConfig): void {
  if (config.nodeEnv !== "test" && config.runtimeEnabled && !config.serviceToken) {
    throw new Error("HERMES_SERVICE_TOKEN is required when Hermes runtime mode is enabled");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function runtimeServiceAuthorized(
  config: RuntimeServiceAuthConfig,
  authorization: string | undefined,
): boolean {
  if (!config.serviceToken) return config.nodeEnv === "test";
  if (!authorization?.startsWith("Bearer ")) return false;
  return safeEqual(authorization.slice("Bearer ".length), config.serviceToken);
}
