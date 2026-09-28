import { compactMessages } from './compact-messages';
import type { OutgoingMessage } from './flow/flow.types';

const menu: OutgoingMessage = {
  kind: 'buttons',
  body: '¿Con qué te ayudo?',
  buttons: [{ id: 'a', title: 'A' }],
};

describe('compactMessages', () => {
  it('folds a text into the menu that follows it (one billed message)', () => {
    const out = compactMessages([
      { kind: 'text', body: '¡Hola de nuevo, Ana!' },
      menu,
    ]);

    expect(out).toEqual([
      { ...menu, body: '¡Hola de nuevo, Ana!\n\n¿Con qué te ayudo?' },
    ]);
  });

  it('joins consecutive texts', () => {
    const out = compactMessages([
      { kind: 'text', body: 'uno' },
      { kind: 'text', body: 'dos' },
    ]);

    expect(out).toEqual([{ kind: 'text', body: 'uno\n\ndos' }]);
  });

  it('never merges into an interactive message that comes first', () => {
    const out = compactMessages([menu, { kind: 'text', body: 'después' }]);

    expect(out).toHaveLength(2);
  });

  it('keeps a text apart when the menu body would pass 1024 chars', () => {
    const out = compactMessages([
      { kind: 'text', body: 'x'.repeat(1010) },
      menu,
    ]);

    expect(out).toHaveLength(2);
  });

  it('keeps a document link out of an interactive body', () => {
    const out = compactMessages([
      { kind: 'text', body: '📄 Póliza\nhttps://example.com/p.pdf' },
      menu,
    ]);

    expect(out).toHaveLength(2);
  });

  it('leaves a single message untouched', () => {
    expect(compactMessages([menu])).toEqual([menu]);
  });
});
