import { it } from "./it.js";
import { en } from "./en.js";

// Registro unico delle lingue abilitate nella PWA. Per aggiungerne una:
// crea <codice>.js, importala qui e aggiungi una sola riga a LOCALES.
// Il gate scripts/i18n-coverage.mjs verifica poi catalogo, runtime e markup.
export const LOCALES = Object.freeze([
  { code: "it", label: "Italiano", dictionary: it },
  { code: "en", label: "English", dictionary: en },
]);

export const SUPPORTED_LOCALES = Object.freeze(LOCALES.map(({ code }) => code));
export const DICTIONARIES = Object.freeze(
  Object.fromEntries(LOCALES.map(({ code, dictionary }) => [code, dictionary]))
);
