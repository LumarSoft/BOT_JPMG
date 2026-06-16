import { InactivityWarningService } from './inactivity-warning.service';

describe('InactivityWarningService', () => {
  it('sends a warning for each claimed conversation', async () => {
    const api = {
      claimPendingWarnings: jest.fn().mockResolvedValue([
        { conversationId: 1, waId: 'w1', phoneNumberId: 'p1' },
        { conversationId: 2, waId: 'w2', phoneNumberId: 'p1' },
      ]),
    };
    const meta = {
      sendText: jest.fn().mockResolvedValue(undefined),
      normalizePhone: jest.fn((p: string) => p),
    };

    const service = new InactivityWarningService(api as any, meta as any);
    await service.sweep();

    expect(api.claimPendingWarnings).toHaveBeenCalledTimes(1);
    expect(meta.sendText).toHaveBeenCalledTimes(2);
  });

  it('does not run a second sweep while one is in flight', async () => {
    let resolveClaim: (v: unknown) => void = () => {};
    const api = {
      claimPendingWarnings: jest
        .fn()
        .mockReturnValueOnce(new Promise((res) => (resolveClaim = res)))
        .mockResolvedValue([]),
    };
    const meta = {
      sendText: jest.fn(),
      normalizePhone: jest.fn((p: string) => p),
    };

    const service = new InactivityWarningService(api as any, meta as any);

    const first = service.sweep(); // leaves the lock held (claim pending)
    await service.sweep(); // should be skipped by the running guard

    expect(api.claimPendingWarnings).toHaveBeenCalledTimes(1);

    resolveClaim([]);
    await first;
  });
});
