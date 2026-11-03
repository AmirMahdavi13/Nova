const HISTORY_LIMIT = 12;

class ActionManager {
  constructor() {
    this.active = null;
    this.history = [];
    this.nextId = 1;
  }

  start(name, username, options = {}) {
    if (this.active) return { accepted: false, reason: 'busy', active: this.snapshot() };

    this.active = {
      id: this.nextId++,
      name,
      username,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 'Starting',
      lastMessage: null,
      persistent: Boolean(options.persistent),
    };
    return { accepted: true, id: this.active.id };
  }

  update(progress) {
    if (!this.active || !progress) return;
    this.active.progress = String(progress).slice(0, 180);
    this.active.updatedAt = Date.now();
  }

  noteMessage(message) {
    if (!this.active || !message) return;
    this.active.lastMessage = String(message).slice(0, 300);
    this.active.progress = this.active.lastMessage;
    this.active.updatedAt = Date.now();
  }

  finish(id, status = 'completed', progress = null, outcome = status) {
    if (!this.active || this.active.id !== id) return;
    this.active.status = status;
    this.active.outcome = outcome;
    this.active.progress = progress || (status === 'completed' ? 'Finished' : 'Stopped');
    this.active.updatedAt = Date.now();
    this.history.unshift({ ...this.active, finishedAt: Date.now() });
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    this.active = null;
  }

  setPersistent(id, persistent = true) {
    if (this.active?.id === id) this.active.persistent = persistent;
  }

  snapshot() {
    if (!this.active) return null;
    const { id, name, username, status, outcome, startedAt, updatedAt, progress, lastMessage, persistent } = this.active;
    return { id, name, username, status, outcome, startedAt, updatedAt, progress, lastMessage, persistent };
  }

  recent() {
    return this.history.map(({ id, name, username, status, outcome, startedAt, finishedAt, progress, lastMessage }) => ({
      id, name, username, status, outcome, startedAt, finishedAt, progress, lastMessage,
    }));
  }
}

module.exports = { ActionManager };
