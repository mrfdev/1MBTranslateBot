class MessageWorkLimitError extends Error {
  constructor(code) {
    super(code);
    this.name = "MessageWorkLimitError";
    this.code = code;
  }
}

class MessageWorkBudget {
  constructor(options = {}) {
    this.maxInspectedChars = options.maxInspectedChars;
    this.maxCandidates = options.maxCandidates;
    this.maxCandidateChars = options.maxCandidateChars;
    this.maxOutputChars = options.maxOutputChars;
    this.maxOutputChunks = options.maxOutputChunks;
    this.maxSendAttempts = options.maxOutputChunks + 1;
    this.inspectedChars = 0;
    this.candidates = 0;
    this.candidateChars = 0;
    this.outputChars = 0;
    this.outputChunks = 0;
    this.sendAttempts = 0;
    this.backgroundTasks = 0;
    this.handlerFinished = false;
    this.controller = new AbortController();
    this.timer = setTimeout(() => {
      this.controller.abort(new MessageWorkLimitError("message-time-budget"));
    }, options.processingBudgetMs);
    this.timer.unref?.();
  }

  get signal() {
    return this.controller.signal;
  }

  assertActive() {
    if (this.signal.aborted) {
      throw new MessageWorkLimitError("message-time-budget");
    }
  }

  inspect(value) {
    this.assertActive();
    this.inspectedChars += String(value ?? "").length;
    if (this.inspectedChars > this.maxInspectedChars) {
      throw new MessageWorkLimitError("message-inspection-budget");
    }
  }

  addCandidate(value) {
    this.assertActive();
    this.candidates += 1;
    this.candidateChars += String(value ?? "").length;
    if (this.candidates > this.maxCandidates) {
      throw new MessageWorkLimitError("message-candidate-count");
    }
    if (this.candidateChars > this.maxCandidateChars) {
      throw new MessageWorkLimitError("message-candidate-characters");
    }
  }

  addOutput(value) {
    this.assertActive();
    this.outputChars += String(value ?? "").length;
    if (this.outputChars > this.maxOutputChars) {
      throw new MessageWorkLimitError("message-output-budget");
    }
  }

  setOutputChunks(count) {
    this.assertActive();
    this.outputChunks = count;
    if (count > this.maxOutputChunks) {
      throw new MessageWorkLimitError("message-output-chunks");
    }
  }

  addSendAttempt() {
    this.assertActive();
    this.sendAttempts += 1;
    if (this.sendAttempts > this.maxSendAttempts) {
      throw new MessageWorkLimitError("message-send-attempts");
    }
  }

  waitFor(promise) {
    this.assertActive();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  trackBackground(promise) {
    this.backgroundTasks += 1;
    const release = () => {
      this.backgroundTasks -= 1;
      this.clearTimerIfFinished();
    };
    Promise.resolve(promise).then(release, release);
    return promise;
  }

  clearTimerIfFinished() {
    if (this.handlerFinished && this.backgroundTasks === 0) {
      clearTimeout(this.timer);
    }
  }

  finish() {
    this.handlerFinished = true;
    this.clearTimerIfFinished();
  }
}

function isMessageWorkLimitError(error) {
  return error instanceof MessageWorkLimitError || error?.name === "AbortError";
}

function shouldHandleMessage(message, options) {
  if (!message.guildId || message.guildId !== options.guildId) {
    return false;
  }
  if (!options.watchedChannelIds.has(message.channelId)) {
    return false;
  }
  if (message.author?.id === options.clientUserId) {
    return false;
  }

  if (message.webhookId) {
    return options.allowAnySource || options.sourceWebhookIds.has(message.webhookId);
  }
  if (message.author?.bot) {
    return options.allowAnySource || options.sourceBotIds.has(message.author.id);
  }
  return options.translateHumanMessages;
}

module.exports = {
  MessageWorkBudget,
  MessageWorkLimitError,
  isMessageWorkLimitError,
  shouldHandleMessage
};
