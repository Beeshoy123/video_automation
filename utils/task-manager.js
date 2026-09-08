class TaskManager {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 1));
    this.maxQueued = Math.max(0, Number(options.maxQueued ?? 100));
    this.active = new Map();
    this.queue = [];
  }

  get activeCount() { return this.active.size; }
  get queuedCount() { return this.queue.length; }
  get size() { return this.active.size + this.queue.length; }
  canAccept() { return this.queue.length < this.maxQueued; }

  submit(id, runner) {
    if (!this.canAccept()) {
      const error = new Error(`Generation queue is full (${this.maxQueued} waiting jobs)`);
      error.status = 429;
      throw error;
    }
    const task = { id, runner, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    this.queue.push(task);
    this.drain();
    return promise;
  }

  drain() {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const task = this.queue.shift();
      const work = Promise.resolve().then(task.runner);
      this.active.set(task.id, work);
      work.then(task.resolve, task.reject).finally(() => {
        this.active.delete(task.id);
        this.drain();
      });
    }
  }
}

module.exports = { TaskManager };
