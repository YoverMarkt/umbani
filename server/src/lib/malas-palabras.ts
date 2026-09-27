// ── MALAS PALABRAS E INSULTOS ──────────────────────────────────────────────
//
// Nace del 2026-09-27. El dueño probó el chat de Umbani escribiendo insultos
// («Putas», «Verga», «Mierda») y el bot contestaba «no te entendí» como a
// cualquier otra cosa. Lo que pidió: la primera vez, una advertencia; la
// segunda, bloqueo automático de 15 días en toda la app.
//
// ⚠️ SOLO LAS FUERTES (decisión del dueño). Los eufemismos que usa gente normal
// sin insultar a nadie —«chuta», «gaver», «carajo», «shunsho», «baboso»— NO
// cuentan: bloquear a un cliente bueno por un «¡chuta, se me olvidó!» es peor
// que dejar pasar un insulto suave.
//
// ⚠️ LA COMIDA NO ES UN INSULTO, y es lo que más cuidado exige en una app de
// comida de Ecuador. Se compara PALABRA ENTERA, nunca un trozo, y por eso:
//   · «ceviche de concha», «conchas asadas» — «concha» sola NO está en la
//     lista; solo las frases («concha de tu madre», «conchetumadre»);
//   · «huevos revueltos», «huevo frito» — está «huevón», no «huevo»;
//   · «pico de gallo», «pollo», «chuchaqui», «culantro», «longaniza»,
//     «cono de helado» (por eso «coño» no está: sin tilde es «cono»),
//     «mariscos», «pingüino», «vergüenza», «disputa», «computadora».
// Cada uno tiene su prueba en `malas-palabras.test.js`.
//
// ⚠️ Se reconocen las formas de esquivar el filtro que se usan de verdad:
// letras estiradas («puuuta»), separadas («p u t a», «p.u.t.a»), números por
// letras («put4», «m1erda») y las abreviaturas («hdp», «ctm», «mrd», «vrg»).

/** Palabras enteras. Van sin tildes y en minúsculas, como queda el texto normalizado. */
const PALABRAS = new Set([
  // verga
  'verga', 'vergas', 'vrg', 'vrga', 'mamaverga', 'mamavergas', 'careverga', 'chupaverga',
  // mierda
  'mierda', 'mierdas', 'mrd',
  // puta
  'puta', 'putas', 'puto', 'putos', 'putita', 'putitas', 'hijueputa', 'hijueputas',
  'hijodeputa', 'hijodeputas', 'hdp', 'hdpt', 'hpta', 'hptas', 'ptm', 'hijueperra',
  // chucha y la madre
  'chucha', 'chuchas', 'chuchatumadre', 'conchatumadre', 'conchetumadre',
  'conchetumare', 'conchesumadre', 'ctm',
  // los demás insultos fuertes
  'maricon', 'maricones', 'marica', 'maricas',
  'cabron', 'cabrona', 'cabrones',
  'pendejo', 'pendeja', 'pendejos', 'pendejas',
  'huevon', 'huevona', 'huevones', 'guevon', 'guevona', 'guevones', 'webon', 'webona', 'weon',
  'cojudo', 'cojuda', 'cojudos', 'cojudas',
  'malparido', 'malparida', 'malparidos', 'gonorrea',
  'imbecil', 'imbeciles', 'estupido', 'estupida', 'estupidos', 'idiota', 'idiotas',
  // ⚠️ «coño» NO: sin tilde queda «cono», y es el cono de HELADO.
  'culo', 'culos', 'culicagado', 'culicagada',
  'pinga', 'pingas', 'chupapinga',
  'zorra', 'zorras', 'perra', 'perras',
  'longo', 'longos', 'mongolo', 'mongola',
])

/** Frases de varias palabras, sobre el texto ya normalizado y con espacios simples. */
const FRASES = [
  /\bconcha (de )?(tu|su) madre\b/,
  /\bchucha (de )?(tu|su) madre\b/,
  /\bhijo de (puta|perra)\b/,
  /\b(la )?puta madre\b/,
]

// Números y símbolos que se usan en lugar de letras.
const EN_LUGAR_DE_LETRAS: Record<string, string> = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's',
}

/** Minúsculas, sin tildes y con los números-letra traducidos. */
function normalizar(texto: string): string {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0134573@$]/g, c => EN_LUGAR_DE_LETRAS[c] ?? c)
}

/**
 * Junta las letras sueltas: «p u t a» y «p.u.t.a» → «puta».
 *
 * Solo tramos de TRES o más letras sueltas, para no pegar un «y» o una «a» a
 * la palabra de al lado.
 */
function juntarLetrasSueltas(palabras: string[]): string[] {
  const salida: string[] = []
  let tramo: string[] = []
  const cerrar = () => {
    if (tramo.length >= 3) salida.push(tramo.join(''))
    else salida.push(...tramo)
    tramo = []
  }
  for (const palabra of palabras) {
    if (palabra.length === 1) tramo.push(palabra)
    else { cerrar(); salida.push(palabra) }
  }
  cerrar()
  return salida
}

/**
 * Las formas en que puede venir estirada una palabra.
 *
 * ⚠️ Dos, y no una: recortar TODA letra repetida convierte «perra» en «pera»
 * —una fruta—, así que se prueba además dejando las dobles que ya estaban.
 * «puuuta» → «puta» por la primera; «perrrra» → «perra» por la segunda.
 */
function formas(palabra: string): string[] {
  return [
    palabra,
    palabra.replace(/(.)\1+/g, '$1'),
    palabra.replace(/(.)\1{2,}/g, '$1$1'),
  ]
}

/** ¿El mensaje lleva una mala palabra o un insulto fuerte? */
export function contieneInsulto(texto: string): boolean {
  const limpio = normalizar(texto)
  const palabras = juntarLetrasSueltas(limpio.split(/[^a-z]+/).filter(Boolean))
  if (palabras.some(palabra => formas(palabra).some(forma => PALABRAS.has(forma)))) return true
  const frase = palabras.join(' ')
  return FRASES.some(expresion => expresion.test(frase))
}
