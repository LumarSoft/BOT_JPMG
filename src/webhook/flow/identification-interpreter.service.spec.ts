import { IdentificationInterpreter } from './identification-interpreter.service';
import { ConfigService } from '@nestjs/config';
import { ApiService } from '../../api/api.service';

describe('IdentificationInterpreter', () => {
  function setup(output: Record<string, unknown>, finish = 'stop') {
    const api = { reportOpenAiUsage: jest.fn().mockResolvedValue(undefined) };
    const service = new IdentificationInterpreter(
      {
        get: (key: string) =>
          key === 'OPENAI_API_KEY' ? 'test-key' : undefined,
      } as ConfigService,
      api as unknown as ApiService,
    );
    const create = jest.fn().mockResolvedValue({
      id: 'test',
      created: 1,
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      choices: [
        {
          finish_reason: finish,
          message: { content: JSON.stringify(output) },
        },
      ],
    });
    (service as unknown as { openai: unknown }).openai = {
      chat: { completions: { create } },
    };
    return { service, api, create };
  }
  const valid = {
    dni: '27345678',
    plate: null,
    action: null,
    clarification: null,
    evidence: '27345678',
  };
  const input = {
    text: 'Mi DNI es 27345678',
    pendingAction: 'documentos' as const,
    phoneNumberId: 'P1',
    history: [{ role: 'assistant', content: 'DNI del titular?' }],
  };
  it('uses context, strict output and bills interpretation usage', async () => {
    const { service, api, create } = setup(valid);
    await expect(service.interpret(input)).resolves.toEqual(valid);
    const calls = create.mock.calls as unknown as Array<
      [
        {
          messages: Array<{ content: string }>;
          response_format: { type: string; json_schema: { strict: boolean } };
        },
      ]
    >;
    expect(calls[0][0].response_format.type).toBe('json_schema');
    expect(calls[0][0].response_format.json_schema.strict).toBe(true);
    const content: unknown = JSON.parse(calls[0][0].messages[1].content);
    expect(content).toMatchObject({
      pendingAction: 'documentos',
      currentMessage: input.text,
      history: input.history,
    });
    expect(api.reportOpenAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'P1',
        requestId: 'test',
        inputTokens: 20,
        outputTokens: 10,
      }),
    );
  });
  it.each([
    { ...valid, dni: '123' },
    { ...valid, dni: '27345679' },
    { ...valid, evidence: 'invented' },
    { ...valid, plate: 'AB123CD' },
    { ...valid, action: 'invented' },
    { ...valid, clarification: 'Cuál es?' },
  ])('rejects invalid or ungrounded results %#', async (output) => {
    const { service } = setup(output);
    await expect(service.interpret(input)).rejects.toThrow();
  });
  it('accepts clarification without looking up a client', async () => {
    const output = {
      dni: null,
      plate: null,
      action: 'siniestro_nueva',
      clarification: '¿Cuál es el DNI del titular?',
      evidence: null,
    };
    const { service } = setup(output);
    await expect(service.interpret(input)).resolves.toEqual(output);
  });
  it('ignores intent evidence when no identifier is returned', async () => {
    const output = {
      dni: null,
      plate: null,
      action: 'siniestro_nueva',
      clarification: '¿Cuál es el DNI?',
      evidence: 'Quiero hacer un siniestro',
    };
    const { service } = setup(output);
    await expect(service.interpret(input)).resolves.toEqual({
      ...output,
      evidence: null,
    });
  });
  it('rejects truncated model output', async () => {
    const { service } = setup(valid, 'length');
    await expect(service.interpret(input)).rejects.toThrow(
      'Interpretación incompleta',
    );
  });
});
