import { ConfigService } from '@nestjs/config';
import { ApiService } from './api.service';

describe('ApiService InfoAuto pagination', () => {
  it('returns brands from every page of the motorcycle catalog', async () => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new ApiService(config);
    const http = (service as any).http;
    http.get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 980, name: 'APPIA' }],
          pagination: { next_page: 2 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 942, name: 'APRILIA' }],
          pagination: { next_page: null },
        },
      });

    const brands = await service.searchBrands('moto', 'a');

    expect(brands.map((brand) => brand.name)).toEqual(['APPIA', 'APRILIA']);
    expect(http.get).toHaveBeenNthCalledWith(1, '/infoauto/moto/brands', {
      params: { query_string: 'a', page: 1, page_size: 100 },
    });
    expect(http.get).toHaveBeenNthCalledWith(2, '/infoauto/moto/brands', {
      params: { query_string: 'a', page: 2, page_size: 100 },
    });
  });

  it('loads motorcycle models directly from the brand', async () => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new ApiService(config);
    const http = (service as any).http;
    http.get = jest.fn().mockResolvedValue({
      data: {
        data: [{ codia: 8810215, description: 'NAVI 110' }],
        pagination: null,
      },
    });

    await expect(
      service.getModels('moto', 881, undefined, 'NAVI'),
    ).resolves.toEqual([{ codia: 8810215, description: 'NAVI 110' }]);
    expect(http.get).toHaveBeenCalledWith('/infoauto/moto/brands/881/models', {
      params: { query_string: 'NAVI', page: 1, page_size: 100 },
    });
  });

  function serviceWith(get: jest.Mock) {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new ApiService(config);
    (service as unknown as { http: { get: jest.Mock } }).http.get = get;
    return service;
  }

  const page = {
    data: { data: [{ id: 12, name: 'CHEVROLET' }], pagination: null },
  };

  it('reuses a catalog read instead of asking InfoAuto again', async () => {
    const get = jest.fn().mockResolvedValue(page);
    const service = serviceWith(get);

    await service.searchBrands('auto', 'chevrolet');
    await service.searchBrands('auto', 'chevrolet');
    await service.searchBrands('auto', 'fiat');

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('retries once when InfoAuto answers 5xx', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 502 } })
      .mockResolvedValueOnce(page);
    const service = serviceWith(get);

    await expect(service.searchBrands('auto', 'x')).resolves.toEqual([
      { id: 12, name: 'CHEVROLET' },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timeout', async () => {
    const get = jest.fn().mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    const service = serviceWith(get);

    await expect(service.searchBrands('auto', 'y')).rejects.toBeDefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty answer (may be a catalog hiccup)', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { data: [], pagination: null } })
      .mockResolvedValueOnce(page);
    const service = serviceWith(get);

    await expect(service.searchBrands('auto', 'z')).resolves.toEqual([]);
    await expect(service.searchBrands('auto', 'z')).resolves.toEqual([
      { id: 12, name: 'CHEVROLET' },
    ]);
  });
});
