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
});
