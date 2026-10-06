const units: Record<string, number> = {
  cero: 0,
  uno: 1,
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
};

/** Reads numeric DNI, spoken groups/digits and Argentine plates without
 * treating the surrounding sentence ("mi DNI es…") as a plate. */
export function identificationFromText(
  text: string,
): { dni: string } | { plate: string } | null {
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const numeric: string[] =
    folded.match(/(?<![\p{L}\d])\d(?:[\d .-]*\d)?(?![\p{L}\d])/gu) ?? [];
  const dnis = numeric
    .map((s) => s.replace(/\D/g, ''))
    .filter((s) => /^\d{7,8}$/.test(s));
  if (dnis.length === 1) return { dni: dnis[0] };
  if (dnis.length > 1) return null;

  const plates: string[] =
    folded.match(
      /(?<![a-z0-9])(?:[a-z]{2}[ -]*\d{3}[ -]*[a-z]{2}|[a-z]{3}[ -]*\d{3})(?![a-z0-9])/g,
    ) ?? [];
  if (plates.length === 1)
    return { plate: plates[0].replace(/[ -]/g, '').toUpperCase() };
  if (plates.length > 1) return null;

  const tokens: string[] = folded.match(/[a-z]+|\d+/g) ?? [];
  const runs: string[][] = [];
  let run: string[] = [];
  for (const token of tokens) {
    if (
      token in units ||
      /^\d+$/.test(token) ||
      ['y', 'mil', 'millon', 'millones'].includes(token)
    ) {
      run.push(token);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  const candidates = runs
    .map((words) => {
      if (words.some((w) => ['mil', 'millon', 'millones'].includes(w))) {
        let total = 0,
          group = 0;
        for (const w of words) {
          if (w === 'y') continue;
          if (w === 'millon' || w === 'millones') {
            total += (group || 1) * 1000000;
            group = 0;
          } else if (w === 'mil') {
            total += (group || 1) * 1000;
            group = 0;
          } else group += units[w] ?? Number(w);
        }
        return String(total + group);
      }
      let digits = '';
      for (let i = 0; i < words.length; i++) {
        if (words[i] === 'y') return '';
        let value = units[words[i]] ?? Number(words[i]);
        if (
          value >= 100 &&
          value < 1000 &&
          i + 1 < words.length &&
          words[i + 1] in units &&
          units[words[i + 1]] < 100
        )
          value += units[words[++i]];
        if (
          value >= 30 &&
          words[i + 1] === 'y' &&
          units[words[i + 2]] > 0 &&
          units[words[i + 2]] < 10
        ) {
          value += units[words[i + 2]];
          i += 2;
        }
        digits += String(value);
      }
      return digits;
    })
    .filter((s) => /^\d{7,8}$/.test(s));
  return candidates.length === 1 ? { dni: candidates[0] } : null;
}
