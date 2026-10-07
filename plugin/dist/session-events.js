"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRACED_EVENTS = exports.OBSERVED_EVENTS = void 0;
/**
 * Events `foldContextQuality` reads. Every one of these has a `case` in that switch.
 */
const OBSERVED_EVENT_TYPES = [
    'turn/start',
    'step/start',
    'compaction/summary',
    'compaction/prune',
    'compaction/end',
    'assistant/message',
    'request/context',
];
/**
 * The subset worth a trace line. `step/start` is folded but deliberately not traced: it fires once per
 * model call, and this plugin reads its own live evidence out of that log.
 */
const TRACED_EVENT_TYPES = [
    'turn/start',
    'assistant/message',
    'request/context',
    'compaction/summary',
    'compaction/prune',
    'compaction/end',
];
/** Runtime membership for the fold's vocabulary. `ReadonlySet<string>` so a plain `string` may be tested. */
exports.OBSERVED_EVENTS = new Set(OBSERVED_EVENT_TYPES);
/** Runtime membership for the traced subset, tested against the same plain `string` a firehose delivers. */
exports.TRACED_EVENTS = new Set(TRACED_EVENT_TYPES);
