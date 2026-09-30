import { findVehicle } from './vehicle-finder';

describe('findVehicle', () => {
  function api() {
    return {
      searchBrands: jest.fn().mockResolvedValue([
        { id: 12, name: 'CHEVROLET' },
        { id: 72, name: 'CHEVROLET CAM.' },
      ]),
      getGroups: jest.fn().mockResolvedValue([
        { id: 2, name: 'ASTRA', prices_from: 1997, prices_to: 2012 },
        { id: 11, name: 'CORSA', prices_from: 2000, prices_to: 2010 },
        { id: 30, name: 'CORSA CLASSIC', prices_from: 2005, prices_to: 2016 },
      ]),
      getModels: jest.fn().mockImplementation((_t, _b, groupId: number) =>
        Promise.resolve(
          groupId === 11
            ? [
                {
                  codia: 120198,
                  description: 'CORSA 1.0 3 P CITY',
                  prices_from: 2000,
                  prices_to: 2003,
                },
                {
                  codia: 120300,
                  description: 'CORSA II 1.8 GL  5P',
                  prices_from: 2008,
                  prices_to: 2010,
                },
              ]
            : [
                {
                  codia: 120500,
                  description: 'CLASSIC 1.4 LS',
                  prices_from: 2010,
                  prices_to: 2016,
                },
              ],
        ),
      ),
    };
  }

  it('resolves brand, line and versions for the year in one call', async () => {
    const a = api();
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'Chevrolet',
      model: 'corsa',
      year: 2010,
    });

    // The exact brand wins over "CHEVROLET CAM.".
    expect(a.getGroups).toHaveBeenCalledWith('auto', 12);
    expect(a.getGroups).toHaveBeenCalledTimes(1);
    expect(res.brand).toEqual({ id: 12, name: 'CHEVROLET' });
    expect(res.versions).toEqual([
      { codia: 120300, description: 'CORSA II 1.8 GL 5P', years: '2008-2010' },
    ]);
  });

  it('prefers the longest matching line ("corsa classic")', async () => {
    const a = api();
    await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'chevrolet',
      model: 'Corsa Classic',
    });

    expect(a.getModels).toHaveBeenCalledWith('auto', 12, 30);
    expect(a.getModels).toHaveBeenCalledTimes(1);
  });

  it('blocks the quote when no version matches the year', async () => {
    const res = await findVehicle(api(), {
      vehicleType: 'auto',
      brand: 'chevrolet',
      model: 'corsa',
      year: 1990,
    });

    expect(res.versions).toBeUndefined();
    expect(res.error).toContain('1990');
  });

  it('rejects Fiat Palio 2024 instead of handing back an older CODIA', async () => {
    const a = {
      searchBrands: jest.fn().mockResolvedValue([{ id: 17, name: 'FIAT' }]),
      getGroups: jest
        .fn()
        .mockResolvedValue([
          { id: 1, name: 'PALIO', prices_from: 1996, prices_to: 2018 },
        ]),
      getModels: jest
        .fn()
        .mockResolvedValue([
          {
            codia: 170001,
            description: 'PALIO 1.4',
            prices_from: 2010,
            prices_to: 2018,
          },
        ]),
    };
    const result = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'Fiat',
      model: 'Palio',
      year: 2024,
    });
    expect(result.error).toContain('2024');
    expect(result.versions).toBeUndefined();
  });

  it('lists the available lines when the model is not found', async () => {
    const res = await findVehicle(api(), {
      vehicleType: 'auto',
      brand: 'chevrolet',
      model: 'tracker',
    });

    expect(res.error).toContain('tracker');
    expect(res.availableModels).toEqual(['ASTRA', 'CORSA', 'CORSA CLASSIC']);
  });

  it('reports an unknown brand', async () => {
    const a = api();
    a.searchBrands.mockResolvedValue([]);
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'Tesla',
      model: 'model 3',
    });

    expect(res.error).toContain('Tesla');
    expect(a.getGroups).not.toHaveBeenCalled();
  });

  it('searches moto models by name, falling back to a token match', async () => {
    const a = {
      searchBrands: jest.fn().mockResolvedValue([{ id: 881, name: 'HONDA' }]),
      getGroups: jest.fn(),
      getModels: jest
        .fn()
        .mockResolvedValueOnce([]) // "wave 110" as a query finds nothing
        .mockResolvedValueOnce([
          { codia: 8810067, description: 'WAVE  100 NF SD' },
          { codia: 8810100, description: 'CB 190R' },
        ]),
    };
    const res = await findVehicle(a, {
      vehicleType: 'moto',
      brand: 'honda',
      model: 'wave 110',
    });

    expect(a.getGroups).not.toHaveBeenCalled();
    expect(res.versions).toEqual([
      { codia: 8810067, description: 'WAVE 100 NF SD', years: undefined },
    ]);
  });

  it('understands "vw" and narrows by the extra words of the model', async () => {
    const a = {
      searchBrands: jest
        .fn()
        .mockResolvedValue([{ id: 46, name: 'VOLKSWAGEN' }]),
      getGroups: jest.fn().mockResolvedValue([{ id: 5, name: 'GOL' }]),
      getModels: jest.fn().mockResolvedValue([
        { codia: 460651, description: 'GOL 1.4 3 P POWER' },
        { codia: 460727, description: 'GOL TREND 1.6 3 P' },
      ]),
    };
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'VW',
      model: 'gol trend',
    });

    expect(a.searchBrands).toHaveBeenCalledWith('auto', 'volkswagen');
    expect(res.versions).toEqual([
      { codia: 460727, description: 'GOL TREND 1.6 3 P', years: undefined },
    ]);
  });

  it('suggests similar brands on a typo', async () => {
    const a = {
      searchBrands: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 36, name: 'RENAULT' }]),
      getGroups: jest.fn(),
      getModels: jest.fn(),
    };
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'renol',
      model: 'sandero',
    });

    expect(a.searchBrands).toHaveBeenLastCalledWith('auto', 'ren');
    expect(res.similarBrands).toEqual(['RENAULT']);
  });

  it('reads "5 puertas" as the catalog\'s "5 P" and keeps the best matches', async () => {
    const a = {
      searchBrands: jest
        .fn()
        .mockResolvedValue([{ id: 12, name: 'CHEVROLET' }]),
      getGroups: jest.fn().mockResolvedValue([{ id: 11, name: 'CORSA' }]),
      getModels: jest.fn().mockResolvedValue([
        { codia: 1, description: 'CORSA 1.4 3 P GL' },
        { codia: 2, description: 'CORSA 1.4 5 P GL' },
        { codia: 3, description: 'CORSA 1.4 5 P GL AA' },
        { codia: 4, description: 'CORSA 1.8 5 P GLS' },
      ]),
    };
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'chevrolet',
      model: 'corsa',
      version: '1.4 GL de 5 puertas',
    });

    expect((res.versions as { codia: number }[]).map((v) => v.codia)).toEqual([
      2, 3,
    ]);
  });

  it('matches "pack 1" with the catalog\'s "PK 1"', async () => {
    const a = {
      searchBrands: jest
        .fn()
        .mockResolvedValue([{ id: 46, name: 'VOLKSWAGEN' }]),
      getGroups: jest.fn().mockResolvedValue([{ id: 7, name: 'GOL TREND' }]),
      getModels: jest.fn().mockResolvedValue([
        { codia: 460728, description: 'GOL TREND 1.6 3 P L/13 PACK 1' },
        { codia: 460717, description: 'GOL TREND 1.6 5 P L/13 PK 1' },
      ]),
    };
    const res = await findVehicle(a, {
      vehicleType: 'auto',
      brand: 'vw',
      model: 'gol trend',
      version: '1.6 5 puertas pack 1',
    });

    expect((res.versions as { codia: number }[]).map((v) => v.codia)).toEqual([
      460717,
    ]);
  });

  describe('the newest model year', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-09-28T12:00:00Z') });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('keeps a version still on sale for this year (InfoAuto lags a year)', async () => {
      const a = {
        searchBrands: jest.fn().mockResolvedValue([{ id: 881, name: 'HONDA' }]),
        getGroups: jest.fn(),
        getModels: jest.fn().mockResolvedValue([
          {
            codia: 8810215,
            description: 'NAVI 110',
            prices_from: 2024,
            prices_to: 2025,
          },
        ]),
      };
      const res = await findVehicle(a, {
        vehicleType: 'moto',
        brand: 'honda',
        model: 'navi',
        year: 2026,
      });

      expect(res.note).toBeUndefined();
      expect(res.versions).toEqual([
        { codia: 8810215, description: 'NAVI 110', years: '2024 en adelante' },
      ]);
    });

    it('does not extrapolate a car model beyond its catalog years', async () => {
      const a = {
        searchBrands: jest
          .fn()
          .mockResolvedValue([{ id: 12, name: 'CHEVROLET' }]),
        getGroups: jest.fn().mockResolvedValue([{ id: 11, name: 'CORSA' }]),
        getModels: jest.fn().mockResolvedValue([
          {
            codia: 1,
            description: 'CORSA OLD',
            prices_from: 2000,
            prices_to: 2010,
          },
          {
            codia: 2,
            description: 'CORSA NEW',
            prices_from: 2020,
            prices_to: 2025,
          },
        ]),
      };
      const res = await findVehicle(a, {
        vehicleType: 'auto',
        brand: 'chevrolet',
        model: 'corsa',
        year: 2026,
      });

      expect(res.versions).toBeUndefined();
      expect(res.error).toContain('2026');
    });
  });
});
