import { BadGatewayException } from '@nestjs/common';
import axios from 'axios';
import { InternalController } from './internal.controller';
import type { MetaService } from './meta.service';
import type { FlowService } from './flow/flow.service';

describe('InternalController.send', () => {
  function setup(deliverText: jest.Mock) {
    const meta = {
      deliverText,
      normalizePhone: (phone: string) => phone.replace(/^549/, '54'),
    };
    return new InternalController(
      meta as unknown as MetaService,
      {} as FlowService,
    );
  }

  it('sends an advisor reply through Meta', async () => {
    const deliverText = jest.fn().mockResolvedValue(undefined);

    await expect(
      setup(deliverText).send({
        to: '5493415555555',
        text: 'Hola',
        phoneNumberId: 'P1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(deliverText).toHaveBeenCalledWith('543415555555', 'Hola', 'P1');
  });

  it('answers 502 with the reason when Meta rejects it, instead of { ok: true }', async () => {
    const rejected = new axios.AxiosError(
      'Request failed',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 400,
        data: { error: { code: 100, error_subcode: 33, message: 'no' } },
      } as never,
    );
    const sending = setup(jest.fn().mockRejectedValue(rejected)).send({
      to: '5493415555555',
      text: 'Hola',
      phoneNumberId: 'P1',
    });

    await expect(sending).rejects.toBeInstanceOf(BadGatewayException);
    await expect(sending).rejects.toThrow('desconectado de Meta');
  });
});
