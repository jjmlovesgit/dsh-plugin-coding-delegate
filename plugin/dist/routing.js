"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyDestination = classifyDestination;
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
function classifyDestination(input) {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const local = norm(input.localProvider);
    const cloud = norm(input.cloudProvider);
    const dest = norm(input.provider);
    // No local provider, or one that IS the cloud provider, means there is nowhere local to go.
    const isCloudOnly = !local || (Boolean(cloud) && local === cloud);
    // 1. Is a reroute to local required, and was it authorised?
    const wantsReroute = input.dlpTripped &&
        (input.dlpAction === 'local' || (input.entropyOnly && input.dlpAction !== 'block'));
    if (wantsReroute) {
        if (isCloudOnly) {
            return {
                destination: 'cloud',
                decision: 'block',
                rerouteLocal: false,
                reason: `Refusing local reroute: localProvider ('${input.localProvider || ''}') is ` +
                    `identical to cloudProvider or undefined. Cannot guarantee payload isolation.`,
            };
        }
        return {
            destination: 'local',
            decision: 'proceed',
            rerouteLocal: true,
            reason: 'Rerouted to local provider due to DLP policy.',
        };
    }
    // 2. A tripped DLP with an explicit block policy is refused outright.
    if (input.dlpTripped && input.dlpAction === 'block') {
        return {
            destination: 'cloud',
            decision: 'block',
            rerouteLocal: false,
            reason: 'DLP violation: dlpAction is configured to block.',
        };
    }
    // 3. No reroute: classify where the payload actually lands. In a cloud-only setup it is cloud
    //    regardless of whether the provider string happens to equal localProvider.
    const effectiveDestination = !isCloudOnly && dest === local ? 'local' : 'cloud';
    return {
        destination: effectiveDestination,
        decision: 'proceed',
        rerouteLocal: false,
    };
}
