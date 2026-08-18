import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MetaService } from './meta.service';
import { SentMessageRegistry } from './sent-message-registry.service';
import { InactivityWarningService } from './inactivity-warning.service';
import { FlowService } from './flow/flow.service';
import { InternalController } from './internal.controller';

@Module({
  imports: [ApiModule],
  controllers: [WebhookController, InternalController],
  providers: [
    SentMessageRegistry,
    WebhookService,
    MetaService,
    InactivityWarningService,
    FlowService,
  ],
})
export class WebhookModule {}
