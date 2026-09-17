/**
 * posterWall.js — muro di locandine decorativo (login + landing).
 *
 * Lista fissa, non una query: le due pagine che lo usano sono pre-auth e una
 * lettura Firestore a ogni visita costerebbe senza dare niente in piu'. Le URL
 * sono le stesse che servono le pagine titolo pubbliche, quindi restano valide
 * finche' esistono quei titoli.
 */

export const WALL_POSTERS = [
  "https://image.tmdb.org/t/p/w500/zolKD2yscZd86GviNa6pBPc6N9o.jpg",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_tv_1396.jpg?alt=media&token=27df07e5-6752-4754-be34-1a7ceeda7a8c",
  "https://image.tmdb.org/t/p/w500/hOpN58hkQGZph5LHhyRrryy1hzF.jpg",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_tv_66732.jpg?alt=media&token=d3b28ded-ba3c-4ee2-8134-c261277959b2",
  "https://image.tmdb.org/t/p/w500/u0xTEHOd8pw6SLGRL5fZyDpoaew.jpg",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_movie_157336.jpg?alt=media&token=a869a44d-5f1f-43a0-9ab5-ef19821aff7a",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_movie_872585.jpg?alt=media&token=ece562be-18a5-4a68-902b-75dc136a8e05",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_tv_62560.jpg?alt=media&token=770edc2a-16be-4d1a-8aab-060d97a94c95",
  "https://image.tmdb.org/t/p/w500/iZTDPQYgr3rhL7hPIYFt17ATp8.jpg",
  "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/posters%2Ftmdb_movie_346698.jpg?alt=media&token=44a830bc-e641-42cb-b85b-68c90d927225",
];

/**
 * Riempie `el` con colonne di locandine. Idempotente: se l'elemento ha gia'
 * figli non fa nulla (evita doppioni su re-render).
 *
 * @param {HTMLElement|null} el
 * @param {{colClass?: string, perCol?: number}} [options]
 */
export function mountPosterWall(el, { colClass = "poster-wall-col", perCol = 8 } = {}) {
  if (!el || el.childElementCount) return;
  const cols = window.matchMedia("(max-width: 899px)").matches ? 5 : 8;
  for (let c = 0; c < cols; c++) {
    const col = document.createElement("div");
    col.className = colClass;
    for (let i = 0; i < perCol; i++) {
      const img = document.createElement("img");
      img.src = WALL_POSTERS[(c * 3 + i) % WALL_POSTERS.length];
      img.alt = "";
      col.appendChild(img);
    }
    el.appendChild(col);
  }
}
