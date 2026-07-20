import type {
  TPSAiGatewayApiSnapshot,
  TPSAiGatewayCapability,
} from "./tps-ai-gateway-contract";

export type TPSAiGatewayCapabilityRegistration = TPSAiGatewayCapability<any, any>;

export type TPSAiCapabilityRegistrationStatus =
  | "registered"
  | "unchanged"
  | "unavailable"
  | "superseded"
  | "cleanup-failed"
  | "failed";

export interface TPSAiCapabilityRegistrationResult {
  status: TPSAiCapabilityRegistrationStatus;
  registeredCount: number;
  unregisterAttemptCount: number;
  unregisterFailureCount: number;
  cleanupBlocked: boolean;
  error?: unknown;
}

export interface TPSCallbackDisposalResult {
  attemptCount: number;
  failureCount: number;
}

export interface TPSCallbackRegistrationResult {
  status: "registered" | "superseded" | "failed";
  callbacks: Array<() => void>;
  registrationAttemptCount: number;
  cleanupAttemptCount: number;
  cleanupFailureCount: number;
  error?: unknown;
}

export class TPSAiCapabilityExecutionLease {
  private active = false;

  constructor(private readonly isConsumerReady: () => boolean) {}

  activate(): void {
    this.active = true;
  }

  invalidate(): void {
    this.active = false;
  }

  assertExecutable(): void {
    if (!this.active || !this.isConsumerReady()) {
      throw new Error("TPS Watchlist AI capability is stale or Watchlist is not ready.");
    }
  }
}

export class TPSGcmActionExecutionLease {
  private active = false;

  constructor(private readonly isConsumerReady: () => boolean) {}

  activate(): void {
    this.active = true;
  }

  invalidate(): void {
    this.active = false;
  }

  isExecutable(): boolean {
    return this.active && this.isConsumerReady();
  }

  assertExecutable(): void {
    if (!this.isExecutable()) {
      throw new Error("TPS Watchlist GCM action is stale or Watchlist is not ready.");
    }
  }
}

/**
 * Owns one provider's complete capability-registration set. Provider swaps are
 * replace-before-register, and a partial new set is never retained.
 */
export class TPSAiCapabilityRegistrationSet {
  private activeSourceApi?: object;
  private unregisterCallbacks: Array<() => void> = [];
  private cleanupBlocked = false;

  synchronize(
    api: Readonly<TPSAiGatewayApiSnapshot> | undefined,
    capabilities: readonly TPSAiGatewayCapabilityRegistration[],
    isCurrent: () => boolean = () => true,
    onCleanupBlocked: () => void = () => undefined,
  ): TPSAiCapabilityRegistrationResult {
    if (!isCurrent()) return this.result("superseded", 0, emptyDisposalResult());
    if (this.cleanupBlocked) return this.result("cleanup-failed", 0, emptyDisposalResult());
    if (api
      && this.activeSourceApi === api.sourceApi
      && this.unregisterCallbacks.length === capabilities.length) {
      return this.result("unchanged", this.unregisterCallbacks.length, emptyDisposalResult());
    }

    const previousCallbacks = this.detachActive();
    let previousCleanup = disposeCallbacksSafely(previousCallbacks);
    if (previousCleanup.failureCount > 0) {
      previousCleanup = this.blockAfterCleanupFailure(previousCleanup, onCleanupBlocked);
      return this.result("cleanup-failed", 0, previousCleanup);
    }
    if (!isCurrent()) return this.result("superseded", 0, previousCleanup);
    if (!api) return this.result("unavailable", 0, previousCleanup);

    const pendingCallbacks: Array<() => void> = [];
    try {
      for (const capability of capabilities) {
        if (!isCurrent()) {
          let rollback = disposeCallbacksSafely(pendingCallbacks);
          if (rollback.failureCount > 0) {
            rollback = this.blockAfterCleanupFailure(rollback, onCleanupBlocked);
          }
          return this.result("superseded", 0, combineCleanup(previousCleanup, rollback));
        }
        pendingCallbacks.push(api.registerCapability(capability));
        if (!isCurrent()) {
          let rollback = disposeCallbacksSafely(pendingCallbacks);
          if (rollback.failureCount > 0) {
            rollback = this.blockAfterCleanupFailure(rollback, onCleanupBlocked);
          }
          return this.result("superseded", 0, combineCleanup(previousCleanup, rollback));
        }
      }
    } catch (error) {
      let rollback = disposeCallbacksSafely(pendingCallbacks);
      if (rollback.failureCount > 0) {
        rollback = this.blockAfterCleanupFailure(rollback, onCleanupBlocked);
      }
      const cleanup = combineCleanup(previousCleanup, rollback);
      return {
        ...this.result(isCurrent() ? "failed" : "superseded", 0, cleanup),
        error,
      };
    }

    if (!isCurrent()) {
      let rollback = disposeCallbacksSafely(pendingCallbacks);
      if (rollback.failureCount > 0) {
        rollback = this.blockAfterCleanupFailure(rollback, onCleanupBlocked);
      }
      return this.result("superseded", 0, combineCleanup(previousCleanup, rollback));
    }
    this.activeSourceApi = api.sourceApi;
    this.unregisterCallbacks = pendingCallbacks;
    return this.result("registered", pendingCallbacks.length, previousCleanup);
  }

  dispose(): TPSAiCapabilityRegistrationResult {
    if (this.cleanupBlocked) return this.result("cleanup-failed", 0, emptyDisposalResult());
    const callbacks = this.detachActive();
    const cleanup = disposeCallbacksSafely(callbacks);
    if (cleanup.failureCount > 0) this.cleanupBlocked = true;
    return this.result(cleanup.failureCount > 0 ? "cleanup-failed" : "unavailable", 0, cleanup);
  }

  private detachActive(): Array<() => void> {
    const callbacks = this.unregisterCallbacks;
    this.activeSourceApi = undefined;
    this.unregisterCallbacks = [];
    return callbacks;
  }

  private blockAfterCleanupFailure(
    cleanup: TPSCallbackDisposalResult,
    onCleanupBlocked: () => void,
  ): TPSCallbackDisposalResult {
    this.cleanupBlocked = true;
    try {
      onCleanupBlocked();
    } catch {
      // Cleanup uncertainty remains fail-closed even if the consumer's fence throws.
    }
    const reentrantCallbacks = this.detachActive();
    return combineCleanup(cleanup, disposeCallbacksSafely(reentrantCallbacks));
  }

  private result(
    status: TPSAiCapabilityRegistrationStatus,
    registeredCount: number,
    cleanup: TPSCallbackDisposalResult,
  ): TPSAiCapabilityRegistrationResult {
    return {
      status,
      registeredCount,
      unregisterAttemptCount: cleanup.attemptCount,
      unregisterFailureCount: cleanup.failureCount,
      cleanupBlocked: this.cleanupBlocked,
    };
  }
}

export function disposeCallbacksSafely(
  callbacks: readonly (() => void)[],
): TPSCallbackDisposalResult {
  let failureCount = 0;
  for (let index = callbacks.length - 1; index >= 0; index -= 1) {
    try {
      callbacks[index]();
    } catch {
      failureCount += 1;
    }
  }
  return { attemptCount: callbacks.length, failureCount };
}

export function registerCallbacksTransactionally(
  registrations: readonly (() => () => void)[],
  isCurrent: () => boolean = () => true,
): TPSCallbackRegistrationResult {
  const callbacks: Array<() => void> = [];
  let registrationAttemptCount = 0;
  try {
    for (const register of registrations) {
      if (!isCurrent()) return rollbackCallbackRegistration("superseded", callbacks, registrationAttemptCount);
      registrationAttemptCount += 1;
      const unregister = register();
      if (typeof unregister !== "function") throw new Error("Registration returned an invalid cleanup callback.");
      callbacks.push(unregister);
      if (!isCurrent()) return rollbackCallbackRegistration("superseded", callbacks, registrationAttemptCount);
    }
    return {
      status: "registered",
      callbacks,
      registrationAttemptCount,
      cleanupAttemptCount: 0,
      cleanupFailureCount: 0,
    };
  } catch (error) {
    return rollbackCallbackRegistration("failed", callbacks, registrationAttemptCount, error);
  }
}

function combineCleanup(
  first: TPSCallbackDisposalResult,
  second: TPSCallbackDisposalResult,
): TPSCallbackDisposalResult {
  return {
    attemptCount: first.attemptCount + second.attemptCount,
    failureCount: first.failureCount + second.failureCount,
  };
}

function emptyDisposalResult(): TPSCallbackDisposalResult {
  return { attemptCount: 0, failureCount: 0 };
}

function rollbackCallbackRegistration(
  status: "superseded" | "failed",
  callbacks: Array<() => void>,
  registrationAttemptCount: number,
  error?: unknown,
): TPSCallbackRegistrationResult {
  const cleanup = disposeCallbacksSafely(callbacks);
  return {
    status,
    callbacks: [],
    registrationAttemptCount,
    cleanupAttemptCount: cleanup.attemptCount,
    cleanupFailureCount: cleanup.failureCount,
    error,
  };
}
