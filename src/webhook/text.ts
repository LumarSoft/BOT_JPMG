/**
 * Lowercases and strips diacritics so keyword patterns match "código" and
 * "codigo" alike. JS `\b` treats accented letters as non-word characters, so
 * patterns run against raw text silently miss or split on them.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
