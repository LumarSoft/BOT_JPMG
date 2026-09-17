import { outboundContentForLog } from './meta.service';

describe('outboundContentForLog', () => {
  it('logs the complete text without duplicating the recipient', () => {
    const content = outboundContentForLog({
      to: '543411111111',
      type: 'text',
      text: { body: 'Primera línea\nSegunda línea' },
    });

    expect(JSON.parse(content)).toEqual({
      type: 'text',
      text: { body: 'Primera línea\nSegunda línea' },
    });
    expect(content).not.toContain('543411111111');
  });

  it('keeps interactive bodies, ids and visible option titles', () => {
    const content = outboundContentForLog({
      to: '543411111111',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Tu auto tiene GNC?' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'gnc_no', title: 'No tiene GNC' },
            },
          ],
        },
      },
    });

    expect(content).toContain('¿Tu auto tiene GNC?');
    expect(content).toContain('gnc_no');
    expect(content).toContain('No tiene GNC');
  });
});
