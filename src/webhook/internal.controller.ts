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

  /** Called by john-api on release so the user gets the welcome menu next time. */
  @Post('reset-flow')
  resetFlow(@Body() body: { phoneNumberId: string; waId: string }) {
    this.flow.reset(`${body.phoneNumberId}:${body.waId}`);
    return { ok: true };
  }
}
