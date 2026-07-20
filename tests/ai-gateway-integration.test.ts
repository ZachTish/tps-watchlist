import test from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  disposeCallbacksSafely,
  registerCallbacksTransactionally,
  TPSAiCapabilityExecutionLease,
  TPSAiCapabilityRegistrationSet,
  TPSGcmActionExecutionLease,
  type TPSAiCapabilityRegistrationResult,
  type TPSAiGatewayCapabilityRegistration,
} from "../src/ai-capability-registration";
import { TPSAiGatewayClient } from "../src/tps-ai-gateway-client";
import {
  TPS_AI_GATEWAY_API_CAPABILITIES,
  TPS_AI_GATEWAY_SERVICE_EVENTS,
} from "../src/tps-ai-gateway-contract";

type Listener = (...args: unknown[]) => void;

class FakeWorkspace {
  private listeners = new Map<string, Set<Listener>>();

  on(eventName: string, callback: Listener): object {
    const listeners = this.listeners.get(eventName) || new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(eventName, listeners);
    return { eventName, callback };
  }

  trigger(eventName: string, ...args: unknown[]): void {
    for (const callback of Array.from(this.listeners.get(eventName) || [])) callback(...args);
  }
}

interface ProviderOptions {
  failCapabilityId?: string;
  throwOnUnregisterIds?: readonly string[];
  onRegister?: (capabilityId: string) => void;
}

interface ProviderHarness {
  descriptor: object;
  activeCapabilityIds: Set<string>;
  registeredCapabilities: Map<string, TPSAiGatewayCapabilityRegistration>;
}

interface CapabilityMutationCounts {
  create: number;
  check: number;
}

function createGuardedWatchlistCapabilities(
  executionLease: TPSAiCapabilityExecutionLease,
  mutations: CapabilityMutationCounts,
): readonly TPSAiGatewayCapabilityRegistration[] {
  return [{
    id: "watchlist.create-watch",
    ownerPluginId: "tps-watchlist",
    description: "Create a watch.",
    requiresConfirmation: true,
    inputSchema: { type: "object" },
    execute: async () => {
      executionLease.assertExecutable();
      mutations.create += 1;
      return { path: "Watches/Test.md", watchId: "watch-test" };
    },
  }, {
    id: "watchlist.check-watch",
    ownerPluginId: "tps-watchlist",
    description: "Check a watch.",
    requiresConfirmation: true,
    inputSchema: { type: "object" },
    execute: async () => {
      executionLease.assertExecutable();
      mutations.check += 1;
      return { outcome: "unchanged" };
    },
  }];
}

function createProvider(
  name: string,
  operations: string[],
  options: ProviderOptions = {},
): ProviderHarness {
  const activeCapabilityIds = new Set<string>();
  const registeredCapabilities = new Map<string, TPSAiGatewayCapabilityRegistration>();
  const api = {
    apiVersion: 1,
    capabilities: TPS_AI_GATEWAY_API_CAPABILITIES,
    completeStructured: async () => ({
      data: {},
      provider: "openai",
      model: "test",
      traceId: "trace",
      attempts: 1,
    }),
    choose: async () => ({
      data: { optionId: "test", reason: "test" },
      option: { id: "test", label: "Test" },
      provider: "openai",
      model: "test",
      traceId: "trace",
      attempts: 1,
    }),
    registerCapability: (capability: TPSAiGatewayCapabilityRegistration) => {
      operations.push(name + ":register:" + capability.id);
      options.onRegister?.(capability.id);
      if (options.failCapabilityId === capability.id) {
        throw new Error("registration failed for " + capability.id);
      }
      activeCapabilityIds.add(capability.id);
      registeredCapabilities.set(capability.id, capability);
      let active = true;
      return () => {
        if (!active) return;
        operations.push(name + ":unregister:" + capability.id);
        if (options.throwOnUnregisterIds?.includes(capability.id)) {
          throw new Error("unregistration failed for " + capability.id);
        }
        active = false;
        activeCapabilityIds.delete(capability.id);
        if (registeredCapabilities.get(capability.id) === capability) {
          registeredCapabilities.delete(capability.id);
        }
      };
    },
    listCapabilities: () => [],
    proposeCapability: async () => ({
      capabilityId: "watchlist.check-watch",
      input: {},
      reason: "test",
      traceId: "trace",
    }),
    executeCapability: async () => ({}),
  };
  return {
    descriptor: {
      protocolVersion: 1,
      providerPluginId: "tps-ai-gateway",
      api,
    },
    activeCapabilityIds,
    registeredCapabilities,
  };
}

function startHarness(workspace: FakeWorkspace): {
  client: TPSAiGatewayClient;
  registrations: TPSAiCapabilityRegistrationSet;
  results: TPSAiCapabilityRegistrationResult[];
  mutations: CapabilityMutationCounts;
} {
  const registrations = new TPSAiCapabilityRegistrationSet();
  const results: TPSAiCapabilityRegistrationResult[] = [];
  const mutations: CapabilityMutationCounts = { create: 0, check: 0 };
  let availabilityEpoch = 0;
  let activeLease: TPSAiCapabilityExecutionLease | undefined;
  const client = new TPSAiGatewayClient({ workspace } as never, "tps-watchlist");
  client.start(
    () => undefined,
    (api) => {
      const currentEpoch = ++availabilityEpoch;
      activeLease?.invalidate();
      activeLease = undefined;
      if (!api) {
        results.push(registrations.dispose());
        return;
      }
      let executionLease!: TPSAiCapabilityExecutionLease;
      executionLease = new TPSAiCapabilityExecutionLease(() => (
        currentEpoch === availabilityEpoch && activeLease === executionLease
      ));
      const result = registrations.synchronize(
        api,
        createGuardedWatchlistCapabilities(executionLease, mutations),
        () => currentEpoch === availabilityEpoch,
        () => {
          activeLease?.invalidate();
          activeLease = undefined;
        },
      );
      if (result.status === "registered") {
        executionLease.activate();
        activeLease = executionLease;
      }
      results.push(result);
    },
  );
  return { client, registrations, results, mutations };
}

test("late availability registers exactly two capabilities and repeated availability is idempotent", () => {
  const workspace = new FakeWorkspace();
  const operations: string[] = [];
  const provider = createProvider("first", operations);
  const { results } = startHarness(workspace);

  assert.deepEqual(operations, []);
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, provider.descriptor);
  assert.deepEqual(operations, [
    "first:register:watchlist.create-watch",
    "first:register:watchlist.check-watch",
  ]);
  assert.deepEqual(Array.from(provider.activeCapabilityIds).sort(), [
    "watchlist.check-watch",
    "watchlist.create-watch",
  ]);
  assert.equal(results[results.length - 1]?.status, "registered");
  assert.equal(results[results.length - 1]?.registeredCount, 2);

  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, provider.descriptor);
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, {
    ...provider.descriptor,
  });
  assert.equal(operations.length, 2);
});

test("provider reload unregisters the old set before the new set and unavailability clears it", () => {
  const workspace = new FakeWorkspace();
  const operations: string[] = [];
  const first = createProvider("first", operations);
  const second = createProvider("second", operations);
  startHarness(workspace);

  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, first.descriptor);
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, second.descriptor);
  assert.deepEqual(operations, [
    "first:register:watchlist.create-watch",
    "first:register:watchlist.check-watch",
    "first:unregister:watchlist.check-watch",
    "first:unregister:watchlist.create-watch",
    "second:register:watchlist.create-watch",
    "second:register:watchlist.check-watch",
  ]);
  assert.equal(first.activeCapabilityIds.size, 0);
  assert.equal(second.activeCapabilityIds.size, 2);

  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.UNAVAILABLE, second.descriptor);
  assert.deepEqual(operations.slice(-2), [
    "second:unregister:watchlist.check-watch",
    "second:unregister:watchlist.create-watch",
  ]);
  assert.equal(second.activeCapabilityIds.size, 0);
});

test("partial registration rolls back and a reentrant provider swap cannot retain a stale set", () => {
  const workspace = new FakeWorkspace();
  const operations: string[] = [];
  const failing = createProvider("failing", operations, {
    failCapabilityId: "watchlist.check-watch",
  });
  const { results } = startHarness(workspace);

  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, failing.descriptor);
  assert.deepEqual(operations, [
    "failing:register:watchlist.create-watch",
    "failing:register:watchlist.check-watch",
    "failing:unregister:watchlist.create-watch",
  ]);
  assert.equal(failing.activeCapabilityIds.size, 0);
  assert.equal(results[results.length - 1]?.status, "failed");

  const replacement = createProvider("replacement", operations);
  let swapped = false;
  const reentrant = createProvider("reentrant", operations, {
    onRegister: () => {
      if (swapped) return;
      swapped = true;
      workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, replacement.descriptor);
    },
  });
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, reentrant.descriptor);
  assert.equal(reentrant.activeCapabilityIds.size, 0);
  assert.deepEqual(Array.from(replacement.activeCapabilityIds).sort(), [
    "watchlist.check-watch",
    "watchlist.create-watch",
  ]);
  assert.ok(
    operations.indexOf("reentrant:unregister:watchlist.create-watch")
      > operations.indexOf("replacement:register:watchlist.check-watch"),
  );
});

test("failed cleanup blocks replacement and stale create/check handlers fail closed", async () => {
  const workspace = new FakeWorkspace();
  const operations: string[] = [];
  const provider = createProvider("provider", operations, {
    throwOnUnregisterIds: ["watchlist.create-watch", "watchlist.check-watch"],
  });
  const replacement = createProvider("replacement", operations);
  const { client, mutations, results } = startHarness(workspace);
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, provider.descriptor);
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, replacement.descriptor);

  assert.equal(results[results.length - 1]?.status, "cleanup-failed");
  assert.equal(results[results.length - 1]?.cleanupBlocked, true);
  assert.equal(provider.activeCapabilityIds.size, 2);
  assert.equal(replacement.activeCapabilityIds.size, 0);
  assert.doesNotMatch(operations.join("\n"), /replacement:register/);

  const context = { sourcePluginId: "test", traceId: "trace", confirmed: true };
  const staleCreate = provider.registeredCapabilities.get("watchlist.create-watch");
  const staleCheck = provider.registeredCapabilities.get("watchlist.check-watch");
  assert.ok(staleCreate);
  assert.ok(staleCheck);
  await assert.rejects(() => staleCreate.execute({}, context), /stale or Watchlist is not ready/);
  await assert.rejects(() => staleCheck.execute({}, context), /stale or Watchlist is not ready/);
  assert.deepEqual(mutations, { create: 0, check: 0 });

  assert.doesNotThrow(() => client.dispose());
  const operationCount = operations.length;
  assert.doesNotThrow(() => client.dispose());
  workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, replacement.descriptor);
  assert.equal(operations.length, operationCount);
  await assert.rejects(() => staleCreate.execute({}, context), /stale or Watchlist is not ready/);
  await assert.rejects(() => staleCheck.execute({}, context), /stale or Watchlist is not ready/);
  assert.deepEqual(mutations, { create: 0, check: 0 });
});

test("create and check execution leases reject before readiness and after unload", async () => {
  let ready = false;
  let unloading = false;
  const mutations: CapabilityMutationCounts = { create: 0, check: 0 };
  const executionLease = new TPSAiCapabilityExecutionLease(() => ready && !unloading);
  executionLease.activate();
  const capabilities = createGuardedWatchlistCapabilities(executionLease, mutations);
  const context = { sourcePluginId: "test", traceId: "trace", confirmed: true };

  await assert.rejects(() => capabilities[0].execute({}, context), /stale or Watchlist is not ready/);
  await assert.rejects(() => capabilities[1].execute({}, context), /stale or Watchlist is not ready/);
  assert.deepEqual(mutations, { create: 0, check: 0 });

  ready = true;
  await capabilities[0].execute({}, context);
  await capabilities[1].execute({}, context);
  assert.deepEqual(mutations, { create: 1, check: 1 });

  unloading = true;
  await assert.rejects(() => capabilities[0].execute({}, context), /stale or Watchlist is not ready/);
  await assert.rejects(() => capabilities[1].execute({}, context), /stale or Watchlist is not ready/);
  assert.deepEqual(mutations, { create: 1, check: 1 });
});

test("safe callback disposal attempts every GCM cleanup when one throws", () => {
  const calls: string[] = [];
  const result = disposeCallbacksSafely([
    () => { calls.push("first"); },
    () => { calls.push("throwing"); throw new Error("cleanup failed"); },
    () => { calls.push("last"); },
  ]);
  assert.deepEqual(calls, ["last", "throwing", "first"]);
  assert.deepEqual(result, { attemptCount: 3, failureCount: 1 });
});

test("transactional GCM registration contains throws and rolls back a superseded lifecycle", () => {
  const failedCalls: string[] = [];
  const failed = registerCallbacksTransactionally([
    () => {
      failedCalls.push("register:first");
      return () => { failedCalls.push("unregister:first"); };
    },
    () => {
      failedCalls.push("register:throwing");
      throw new Error("registration failed");
    },
    () => {
      failedCalls.push("register:never");
      return () => undefined;
    },
  ]);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failedCalls, ["register:first", "register:throwing", "unregister:first"]);
  assert.equal(failed.registrationAttemptCount, 2);
  assert.equal(failed.cleanupAttemptCount, 1);

  let current = true;
  const supersededCalls: string[] = [];
  const superseded = registerCallbacksTransactionally([
    () => {
      supersededCalls.push("register:first");
      current = false;
      return () => { supersededCalls.push("unregister:first"); };
    },
    () => {
      supersededCalls.push("register:never");
      return () => undefined;
    },
  ], () => current);
  assert.equal(superseded.status, "superseded");
  assert.deepEqual(supersededCalls, ["register:first", "unregister:first"]);
  assert.equal(superseded.cleanupFailureCount, 0);
});

test("a leaked partial GCM action remains inert when rollback cleanup also throws", async () => {
  let activeLease: TPSGcmActionExecutionLease | undefined;
  let mutationCount = 0;
  let leakedHandler: (() => Promise<void>) | undefined;
  let executionLease!: TPSGcmActionExecutionLease;
  executionLease = new TPSGcmActionExecutionLease(() => activeLease === executionLease);

  const result = registerCallbacksTransactionally([
    () => {
      leakedHandler = async () => {
        executionLease.assertExecutable();
        mutationCount += 1;
      };
      return () => {
        throw new Error("provider retained the first action");
      };
    },
    () => {
      throw new Error("second registration failed");
    },
  ]);
  if (result.status === "registered") {
    executionLease.activate();
    activeLease = executionLease;
  } else {
    executionLease.invalidate();
  }

  assert.equal(result.status, "failed");
  assert.equal(result.cleanupFailureCount, 1);
  const retainedHandler = leakedHandler;
  assert.ok(retainedHandler);
  await assert.rejects(() => retainedHandler(), /GCM action is stale or Watchlist is not ready/);
  assert.equal(mutationCount, 0);
});

test("Watchlist main uses only the event client for AI lifecycle and retains only the GCM retry", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /new TPSAiGatewayClient\(this\.app, this\.manifest\.id\)/);
  assert.match(source, /this\.aiGatewayClient\.start\([\s\S]*this\.handleAiGatewayAvailability\(api\)/);
  assert.match(source, /const layoutLifecycleEpoch = this\.lifecycleEpoch/);
  assert.match(source, /if \(!this\.isCurrentLifecycle\(layoutLifecycleEpoch\)\) return/);
  assert.match(source, /this\.initializeIntegrations\(layoutLifecycleEpoch\)/);
  assert.doesNotMatch(source, /tpsAiGateway/);
  assert.doesNotMatch(source, /getPlugin\?\.\("tps-ai-gateway"\)/);
  assert.doesNotMatch(source, /getAiGatewayApi/);

  const integrationInitialization = source.slice(
    source.indexOf("private async initializeIntegrations("),
    source.indexOf("private registerCommands("),
  );
  assert.match(integrationInitialization, /initializeIntegrations\(lifecycleEpoch: number\)/);
  assert.match(integrationInitialization, /this\.registerGcmActions\(lifecycleEpoch\)/);
  assert.match(integrationInitialization, /window\.setTimeout/);
  assert.match(integrationInitialization, /this\.aiIntegrationsReady = true/);
  assert.match(integrationInitialization, /this\.registerAvailableAiCapabilities\("integrations-ready"\)/);
  assert.doesNotMatch(integrationInitialization, /basesReady/);
  const ensureBasesIndex = integrationInitialization.indexOf("await this.ensureBases(false)");
  const postBaseFenceIndex = integrationInitialization.indexOf(
    "if (!this.isCurrentLifecycle(lifecycleEpoch)) return",
    ensureBasesIndex,
  );
  const gcmRegistrationIndex = integrationInitialization.indexOf(
    "this.registerGcmActions(lifecycleEpoch)",
    postBaseFenceIndex,
  );
  assert.ok(ensureBasesIndex >= 0 && postBaseFenceIndex > ensureBasesIndex);
  assert.ok(gcmRegistrationIndex > postBaseFenceIndex);
  assert.match(integrationInitialization, /catch \(error\) \{\s*if \(this\.isCurrentLifecycle\(lifecycleEpoch\)\) logger\.failure\("Bases"/);
  const retry = integrationInitialization.slice(
    integrationInitialization.indexOf("const retry"),
    integrationInitialization.indexOf("this.register(() => window.clearTimeout(retry))"),
  );
  assert.doesNotMatch(retry, /AiGateway|AiCapabilities|aiGateway|aiCapabilities/);
  assert.match(retry, /this\.isCurrentLifecycle\(lifecycleEpoch\)/);

  const gcmRegistration = source.slice(
    source.indexOf("private registerGcmActions("),
    source.indexOf("private handleAiGatewayAvailability("),
  );
  assert.match(gcmRegistration, /registerCallbacksTransactionally/);
  assert.match(gcmRegistration, /new TPSGcmActionExecutionLease/);
  assert.match(gcmRegistration, /if \(result\.status === "registered"\) \{\s*executionLease\.activate\(\)/);
  assert.match(gcmRegistration, /else \{\s*executionLease\.invalidate\(\)/);
  assert.match(gcmRegistration, /this\.isCurrentLifecycle\(lifecycleEpoch\)/);
  assert.match(gcmRegistration, /this\.gcmRegistrationBlocked/);
  assert.match(gcmRegistration, /result\.status === "failed" \|\| result\.cleanupFailureCount > 0/);
  assert.match(gcmRegistration, /actions:register-failed/);

  const descriptors = source.slice(
    source.indexOf("private createAiCapabilityDescriptors("),
    source.indexOf("private disposeAiCapabilityRegistrations("),
  );
  assert.deepEqual(descriptors.match(/id: "watchlist\.[^"]+"/g), [
    "id: \"watchlist.create-watch\"",
    "id: \"watchlist.check-watch\"",
  ]);
  assert.equal((descriptors.match(/requiresConfirmation: true/g) || []).length, 2);
  assert.equal((descriptors.match(/executionLease\.assertExecutable\(\)/g) || []).length, 2);
  assert.match(source, /this\.aiIntegrationsReady[\s\S]*this\.aiCatalogReady[\s\S]*!this\.hasUntrustedCatalogPending\(\)/);
  assert.match(source, /capabilities:registration-deferred/);
  assert.match(source, /\(\) => this\.invalidateAiCapabilityExecutionLease\(\)/);

  const unload = source.slice(source.indexOf("onunload(): void"), source.indexOf("async saveSettings()"));
  assert.ok(
    unload.indexOf("this.disposeAiCapabilityRegistrations") < unload.indexOf("this.aiGatewayClient?.dispose()"),
  );
  assert.ok(unload.indexOf("this.aiGatewayClient?.dispose()") < unload.indexOf("this.stopCatalogRecovery()"));
  assert.ok(unload.indexOf("this.aiGatewayClient?.dispose()") < unload.indexOf("this.unregisterGcmActions"));
  assert.match(unload, /disposeCallbacksSafely\(this\.unregisterGcmActions\.splice\(0\)\)/);
  assert.ok(
    unload.indexOf("this.invalidateGcmActionExecutionLease()")
      < unload.indexOf("disposeCallbacksSafely(this.unregisterGcmActions.splice(0))"),
  );
  assert.match(unload, /if \(gcmCleanup\.failureCount > 0\) \{\s*this\.gcmRegistrationBlocked = true/);
});
