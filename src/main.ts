import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Meta's Coexistence history webhook can exceed Express' 100 KB default.
  app.useBodyParser('json', { limit: '10mb' });
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  new Logger('Bootstrap').log(`App running on port ${port}`);
}
bootstrap();
