export interface DestinationClassificationInput {
    provider: string;
    localProvider: string;
    cloudProvider: string;
    dlpTripped: boolean;
    entropyOnly: boolean;
    dlpAction?: 'block' | 'local' | 'warn' | string;
}
export interface DestinationClassificationResult {
    destination: 'cloud' | 'local';
    decision: 'proceed' | 'block';
    rerouteLocal: boolean;
    reason?: string;
}
/**
 * Where an outbound request will actually land, and whether that is allowed.
 *
 * Both halves of this decision used to be made by comparing provider IDs, and both fail in the
 * documented cloud-only setup where `localProvider` and `cloudProvider` are the same id:
 *
 *   1. An entropy-only DLP hit forced a local reroute even when `dlpAction` was 'block', so the
 *      payload was pinned to the cloud it was meant to be kept away from -- and the log said it was
 *      pinned to the LOCAL worker.
 *   2. `destination` was then inferred from `provider === localProvider`, which is true in that
 *      setup, so source egress classified the route as local and ALLOWED source to the cloud.
 *
 * The plugin cannot see the architect's endpoint, so where it cannot tell it refuses rather than
 * guessing. `dlpAction` is an explicit input for the same reason: a caller that pre-computes
 * "should I reroute" cannot express that 'block' was overridden, which is how half 1 stayed hidden.
 *
 * `dlpAction` undefined preserves the previous behaviour deliberately: entropy-only hits reroute,
 * high-confidence hits do not. Only an explicit 'block' changes that, and only 'local' authorises a
 * reroute for a high-confidence hit.
 */
export declare function classifyDestination(input: DestinationClassificationInput): DestinationClassificationResult;
