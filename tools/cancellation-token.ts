export class CancellationToken {
  private _cancelled: boolean = false;
  private _listeners: Array<() => void> = [];

  constructor() {}

  isCancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    if (this._cancelled) {
      return;
    }
    this._cancelled = true;
    const listeners = this._listeners;
    this._listeners = [];
    for (const listener of listeners) {
      listener();
    }
  }

  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new Error('Operation was cancelled');
    }
  }

  onCancel(callback: () => void): () => void {
    if (this._cancelled) {
      callback();
      return () => {};
    }
    this._listeners.push(callback);
    return () => {
      const index = this._listeners.indexOf(callback);
      if (index !== -1) {
        this._listeners.splice(index, 1);
      }
    };
  }
}
