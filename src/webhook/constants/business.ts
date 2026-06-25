import type { ProductCatalogItem } from '../../api/api.types';

/**
 * App-level fallback for the attention window. The real value comes from the API
 * (Producer.attentionHours, surfaced on the bot context); this is only used when
 * the API is unreachable or the producer has none set. Kept in sync with the
 * API's DEFAULT_ATTENTION_HOURS so a fallback never contradicts the configured
 * hours.
 */
export const DEFAULT_ATTENTION_HOURS = 'lunes a viernes de 8 a 16 hs';

/** Resolves the attention window to display, falling back to the app default. */
export function attentionHoursOf(value?: string | null): string {
  const v = value?.trim();
  return v ? v : DEFAULT_ATTENTION_HOURS;
}

/**
 * Renders the product catalog as a compact, price-free reference block for the
 * FAQ system prompt, so the model can answer "¿qué cubre X?" with the exact same
 * wording as the web. Prices are deliberately omitted — the prompt instructs the
 * model to route to a quote/advisor for pricing.
 */
export function renderCatalogForPrompt(items: ProductCatalogItem[]): string {
  if (items.length === 0) return '';
  const blocks = items.map((p) => {
    const lines = [
      `- *${p.label}* (${p.sub}): ${p.summary}`,
      `  Incluye: ${p.includes.join(', ')}.`,
    ];
    if (p.excludes.length > 0) {
      lines.push(`  No incluye: ${p.excludes.join(', ')}.`);
    }
    return lines.join('\n');
  });
  return blocks.join('\n');
}
