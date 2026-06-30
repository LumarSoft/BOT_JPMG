import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from './internal-auth.guard';
import { MetaService } from './meta.service';
import { FlowService } from './flow/flow.service';

@UseGuards(InternalAuthGuard)
@Controller('internal')
export class InternalController {
  constructor(
    private readonly meta: MetaService,
    private readonly flow: FlowService,
  ) {}

  /** Called by john-api when an admin agent sends a message from the inbox. */
  @Post('send')
  async send(
    @Body() body: { to: string; text: string; phoneNumberId: string },
  ) {
    await this.meta.sendText(
      this.meta.normalizePhone(body.to),
      body.text,
      body.phoneNumberId,
    );
    return { ok: true };
  }

  /**
   * Called by john-api to send an approved template (e.g. the web-quote
   * follow-up). Templates are the only way to reach a client outside the 24h
   * window. `params` fill the template's body variables in order.
   */
  @Post('send-template')
  async sendTemplate(
    @Body()
    body: { to: string; phoneNumberId: string; template: string; lang?: string; params?: string[] },
  ) {
    await this.meta.sendTemplate(
      this.meta.normalizePhone(body.to),
      body.phoneNumberId,
      body.template,
      body.lang ?? 'es_AR',
      body.params ?? [],
    );
    return { ok: true };
  }

  /** Called by john-api on release so the user gets the welcome menu next time. */
  @Post('reset-flow')
  resetFlow(@Body() body: { phoneNumberId: string; waId: string }) {
    this.flow.reset(`${body.phoneNumberId}:${body.waId}`);
    return { ok: true };
  }
}
