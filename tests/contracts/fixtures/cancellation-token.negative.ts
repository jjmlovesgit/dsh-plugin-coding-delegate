// Negative fixture for cancellation-token.contract.cjs.
//
// Correct in every respect EXCEPT that `cancel()` never invokes the listeners it collected: they are
// stored, unsubscribed correctly, and delivered only to a listener that registers AFTER cancellation.
// That is the plausible wrong implementation -- a token that reports its state honestly while silently
// dropping every cancellation callback, which is exactly the failure an onCancel API exists to prevent.
export type CancelListener = () => void;

export class CancellationToken {
  #cancelled = false;
  #listeners: CancelListener[] = [];

  isCancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    this.#cancelled = true;
    // THE DEFECT: the registered listeners are never invoked.
  }

  throwIfCancelled(): void {
    if (this.#cancelled) {
      throw new Error('Operation cancelled');
    }
  }

  onCancel(listener: CancelListener): () => void {
    if (this.#cancelled) {
      listener();
      return () => undefined;
    }
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((entry) => entry !== listener);
    };
  }
}
