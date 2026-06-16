import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MetaService } from './meta.service';
import { InactivityWarningService } from './inactivity-warning.service';

@Module({
  imports: [ApiModule],
  controllers: [WebhookController],
  providers: [WebhookService, MetaService, InactivityWarningService],
})
export class WebhookModule {}
