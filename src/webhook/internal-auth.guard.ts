import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guards the /internal/* endpoints that the john-api calls back to the bot
 * (e.g. to deliver an agent message or reset flow state). Uses the same
 * BOT_SECRET shared between the two processes.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('BOT_SECRET');
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();

    if (!secret || req.headers['x-bot-secret'] !== secret) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    return true;
  }
}
