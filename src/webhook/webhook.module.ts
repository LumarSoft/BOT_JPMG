import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ApiModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
