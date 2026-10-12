/**
 * Git-anchored metadata storage for a signed generation record.
 *
 * NOT APPEND-ONLY, AND THE NAME MATTERS. `git notes` writes a ref (`refs/notes/...`) that any writer
 * can rewrite or delete, that `-f` deliberately OVERWRITES on a re-run, and that git neither fetches
 * nor pushes without an explicit refspec. Calling this an append-only ledger would claim a property
 * the mechanism does not enforce. What makes a record tamper-EVIDENT is the signature over its
 * canonical bytes together with the hashes inside it; the ref is where the record is kept, not what
 * protects it. Genuine append-only properties need a WORM sink or a transparency log (Sigstore
 * Rekor), not a git ref -- and saying so is cheaper than being asked.
 *
 * WHY THE COMMAND IS BUILT BY A PURE FUNCTION. The arguments are assembled from operator
 * configuration and a commit read out of the repository, then handed to `execFileSync` WITHOUT a
 * shell, so nothing here can be shell-injected. A malformed ref or object name is nevertheless a
 * request to write somewhere unintended, so both are validated and a rejected input returns a reason
 * instead of a command.
 *
 * THIS MODULE DOES NOT RUN ANYTHING. It decides what the arguments would be; the caller executes and
 * reports. That separation is what lets every rejection path above be tested without a repository.
 */
export interface NotesCommandInput {
    /** A full git object name, as read from `git rev-parse`, never taken from a caller. */
    commit: string;
    /** A full ref path under `refs/notes/`. */
    notesRef: string;
    /** The record to store. */
    body: string;
}
/** Either a command to run, or the reason no command was built. */
export type NotesCommand = {
    ok: true;
    args: string[];
} | {
    ok: false;
    reason: string;
};
/** A ref this module is willing to write to: a full path under `refs/notes/`, and nothing else. */
export type NotesRefCheck = {
    ok: true;
    value: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Validate a `refs/notes/...` path.
 *
 * A FULL PATH IS REQUIRED rather than a shorthand. `--ref=delegations` resolves relative to whatever
 * the repository's notes configuration says, which would let the plugin write somewhere the operator
 * did not name; requiring the prefix means the destination is the one written down.
 */
export declare function validateNotesRef(raw: string): NotesRefCheck;
/**
 * The exact arguments for `git notes add`, or the reason none were built.
 *
 * `-f` OVERWRITES an existing note for the same commit. That is deliberate -- a unit run twice should
 * leave one current record rather than fail on the second attempt -- and it is precisely why the
 * storage is not described as append-only anywhere.
 *
 * The caller supplies the workspace: `-C <dir>` is prepended by the caller, because this process's
 * cwd is not the delegation's workspace and a note written to the wrong repository would be worse
 * than one not written at all.
 */
export declare function buildNotesCommand(input: NotesCommandInput): NotesCommand;
