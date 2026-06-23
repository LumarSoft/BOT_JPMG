import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiService } from '../api/api.service';
import { MetaService } from './meta.service';
import { attentionHoursOf } from './constants/business';

/** Builds the inactivity notice, quoting the producer's own attention window. */
function warningText(attentionHours?: string | null): string {
  return (
    'Por inactividad damos por finalizada esta conversación. 🙂 ' +
    'Cuando quieras retomar, escribinos y arrancamos de nuevo. ' +
    `Te atendemos de ${attentionHoursOf(attentionHours)}.`
  );
}

/**
 * Pushes the inactivity warning. Every minute it asks john-api for the
 * conversations idle past the timeout — the API claims them atomically so a
 * warning is never sent twice — and sends each one a WhatsApp notice. Cheap by
 * design: one API call per minute, no per-conversation timers, and nothing runs
 * against an idle chat beyond that single sweep.
 */
@Injectable()
export class InactivityWarningService {
  private readonly logger = new Logger(InactivityWarningService.name);
  private running = false;

  constructor(
    private readonly api: ApiService,
    private readonly meta: MetaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (this.running) return; // skip if the previous sweep is still in flight
    this.running = true;

    try {
      const pending = await this.api.claimPendingWarnings();
      for (const c of pending) {
        await this.meta.sendText(
          this.meta.normalizePhone(c.waId),
          warningText(c.attentionHours),
          c.phoneNumberId,
        );
      }
      if (pending.length > 0) {
        this.logger.log(`Avisos de inactividad enviados: ${pending.length}`);
      }
    } catch (error) {
      this.logger.error(
        `Sweep de inactividad falló: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
