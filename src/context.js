const { BoundedTtlCache } = require("./cache");

function normalizeParticipant(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function directMessageKey(actor, recipient) {
  const participants = [normalizeParticipant(actor), normalizeParticipant(recipient)].filter(Boolean);
  if (participants.length !== 2) {
    return null;
  }

  participants.sort();
  return `dm:${participants.join(":")}`;
}

class ConversationContextStore {
  constructor(options = {}) {
    this.maxMessages = Math.max(1, Math.floor(Number(options.maxMessages) || 5));
    const maxConversations = Math.max(0, Math.floor(Number(options.maxConversations) || 0));
    const ttlMs = Math.max(0, Math.floor(Number(options.ttlMs) || 0));
    const now = typeof options.now === "function" ? options.now : Date.now;

    this.conversations = new BoundedTtlCache({
      maxEntries: maxConversations,
      ttlMs,
      now
    });
    this.lastPeers = new BoundedTtlCache({
      maxEntries: maxConversations * 2,
      ttlMs,
      now
    });
  }

  beginTurn(entry) {
    const key = this.resolveConversationKey(entry);
    return Object.freeze({
      key,
      context: this.contextForTurn({ key })
    });
  }

  beginTurns(entries) {
    return Object.freeze(
      entries.map((entry) =>
        ["direct-message", "reply"].includes(entry?.kind) ? this.beginTurn(entry) : null
      )
    );
  }

  contextForTurn(turn) {
    return turn?.key ? [...(this.conversations.get(turn.key) || [])] : [];
  }

  remember(turn, entry, result) {
    const key = turn?.key;
    if (!key) {
      return;
    }

    // Peer routing is useful even when no translation was emitted, but raw
    // message history is retained only for successfully translated turns.
    if (!Array.isArray(result?.translations) || !result.translations[0]) {
      return;
    }

    const previous = this.conversations.get(key) || [];
    const translation = result.translations[0];
    const next = [
      ...previous,
      {
        speaker: entry.actor || "player",
        original: entry.text,
        translation,
        language: result?.language || null,
        confidence: Number.isFinite(result?.confidence) ? result.confidence : null
      }
    ].slice(-this.maxMessages);

    this.conversations.set(key, next);
  }

  snapshot() {
    return {
      conversations: this.conversations.size,
      peer_routes: this.lastPeers.size
    };
  }

  resolveConversationKey(entry) {
    const actor = normalizeParticipant(entry?.actor);
    let recipient = normalizeParticipant(entry?.recipient);
    if (!actor) {
      return null;
    }

    if (recipient) {
      this.lastPeers.set(actor, recipient);
      this.lastPeers.set(recipient, actor);
      return directMessageKey(actor, recipient);
    }

    if (entry?.kind !== "reply") {
      return null;
    }

    recipient = this.lastPeers.get(actor);
    if (!recipient) {
      return null;
    }

    // Reply resolution is sliding: an active /r conversation should not lose
    // its peer merely because the last explicit /msg crossed the TTL boundary.
    this.lastPeers.set(actor, recipient);
    this.lastPeers.set(recipient, actor);
    return directMessageKey(actor, recipient);
  }
}

module.exports = {
  ConversationContextStore,
  directMessageKey
};
