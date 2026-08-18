import { Injectable } from '@nestjs/common';

/**
 * Remembers the ids of messages WE sent through the Cloud API.
 *
 * Why this exists: depending on the account, Meta may echo back messages the
 * business sent *via the API* alongside the ones typed in the WhatsApp Business
 * app. Without this filter the bot sees its own replies as "a human is typing"
 * and pauses itself in every single conversation — the bot would silently stop
 * working and the logs would show nothing wrong.
 *
 * Bounded on purpose: entries expire after a short window because an echo lands
 * within seconds of the send, and the map is capped so a busy number can never
 * grow it without limit.
 */
@Injectable()
export class SentMessageRegistry {
  private readonly ids = new Map<string, number>();
  private static readonly TTL_MS = 10 * 60 * 1000;
  private static readonly MAX = 5000;

  remember(id: string | null | undefined): void {
    if (!id) return;
    this.ids.set(id, Date.now());
    this.prune();
  }

  /** True when this echo is just our own outbound message coming back. */
  isOurs(id: string | null | undefined): boolean {
    if (!id) return false;
    const at = this.ids.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > SentMessageRegistry.TTL_MS) {
      this.ids.delete(id);
      return false;
    }
    return true;
  }

  private prune(): void {
    if (this.ids.size <= SentMessageRegistry.MAX) return;
    const now = Date.now();
    for (const [id, at] of this.ids) {
      if (now - at > SentMessageRegistry.TTL_MS) this.ids.delete(id);
    }
    // Still over the cap after expiring: drop oldest-inserted first. Iterating
    // the keys avoids `.next().value`, which types as `any`.
    for (const id of this.ids.keys()) {
      if (this.ids.size <= SentMessageRegistry.MAX) break;
      this.ids.delete(id);
    }
  }
}
