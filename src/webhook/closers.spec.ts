import type { ConversationMessage } from '../api/api.types';
import {
  closesHumanConversation,
  isCloser,
  lastSpeakerIsHuman,
} from './closers';

const msg = (
  role: ConversationMessage['role'],
  source?: string,
): ConversationMessage => ({
  id: 1,
  role,
  content: 'x',
  createdAt: '2026-10-07T11:00:00Z',
  source,
});

describe('isCloser', () => {
  it.each([
    'Gracias',
    'muchas gracias!!',
    'Mil gracias Mili, un abrazo',
    'ok',
    'Okey dale',
    'dale, listo',
    'ya está',
    'Perfecto, gracias por todo',
    'Buenísimo',
    'si',
    'No, gracias',
    'Hasta mañana!',
    'gracias igualmente, buen finde',
    '👍',
    '🙏🙏',
    'Genia!!! 😘',
    'Gracias Mili!',
    'dale Juan, gracias',
  ])('treats %p as a closing line', (text) => {
    expect(isCloser(text)).toBe(true);
  });

  it.each([
    'Gracias, y cuánto sale la cuota?',
    'hola',
    'ok 30379505',
    'dale, pasame el cupón de octubre',
    'Quiero saber si con esto del siniestro me cubren algo',
    'Fiat siena modelo 2002',
    'gracias cupon octubre',
    'Mili',
    'patente',
    'gracias gracias gracias gracias gracias gracias gracias gracias gracias',
    '',
    '   ',
  ])('does not treat %p as a closing line', (text) => {
    expect(isCloser(text)).toBe(false);
  });
});

describe('lastSpeakerIsHuman', () => {
  it('recognises a WhatsApp Business app reply and an inbox reply', () => {
    expect(
      lastSpeakerIsHuman([msg('user'), msg('assistant', 'app_echo')]),
    ).toBe(true);
    expect(lastSpeakerIsHuman([msg('user'), msg('agent')])).toBe(true);
  });

  it('is false after a bot message, a customer message or an empty history', () => {
    expect(
      lastSpeakerIsHuman([
        msg('assistant', 'app_echo'),
        msg('assistant', 'live'),
      ]),
    ).toBe(false);
    expect(
      lastSpeakerIsHuman([msg('assistant', 'app_echo'), msg('user')]),
    ).toBe(false);
    expect(lastSpeakerIsHuman([])).toBe(false);
  });
});

describe('closesHumanConversation', () => {
  it('is true only for a closer right after a person spoke', () => {
    const afterHuman = [msg('user'), msg('assistant', 'app_echo')];
    expect(closesHumanConversation('Gracias!', afterHuman)).toBe(true);
    expect(closesHumanConversation('y el cupón?', afterHuman)).toBe(false);
    expect(
      closesHumanConversation('Gracias!', [msg('assistant', 'live')]),
    ).toBe(false);
  });
});
