#!/usr/bin/env python3
"""Sorgente parametrica del mark Somto.

Concept: la "S" e' una silhouette PIENA; il tasto play e' una FINESTRA
luminosa ricavata dalla S stessa (foro che lascia passare un triangolo
luminoso) -> il play e' parte della S, non sovrapposto.

Genera due file:
  somto-mark.svg        statico
  somto-mark-anim.svg   animato: una "penna" disegna la S dall'alto, al
                        centro ripassa/marca il triangolo play 3 volte
                        (il play compare e si illumina), poi prosegue e
                        chiude la S. Penna mai staccata (un solo percorso).
                        L'animazione e' un reveal: il percorso-penna fa da
                        maschera che scopre progressivamente il logo pieno.

Per modificare: cambia i parametri e rilancia  python3 build-somto-mark.py
"""

import math
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
VB_W, VB_H = 247, 275
DUR = 4.4                      # durata animazione (s)

# --- silhouette S tracciata dal PNG originale (cv2), scala 0.5 ---
OUTER = [(47.5,22.5),(12.0,74.5),(27.0,144.5),(95.5,194.5),(153.5,171.5),(175.0,199.5),
         (156.5,220.0),(82.0,220.0),(64.0,193.0),(18.0,193.0),(27.5,246.0),(58.5,264.5),
         (203.0,249.0),(234.5,194.0),(219.0,132.5),(102.0,80.0),(83.0,101.0),(70.5,74.0),
         (89.0,55.5),(157.5,55.5),(175.0,82.5),(221.0,82.5),(211.0,27.5),(175.0,10.0)]
PLAY = [(96.0,106.0),(170.0,140.0),(100.0,176.0)]   # triangolo play
SMOOTH, PLAY_R = 3, 8

# percorso-penna: terminale alto -> ansa S -> loop triangolo x3 -> ansa bassa.
# segmenti ('C',p0,c1,c2,p3) | ('L',p0,p1) ; il loop e' i vertici del play.
TL, RP, BL = (96, 106), (170, 140), (100, 176)
PEN_SEGS = [
    ('C',(198,40),(196,-8),(52,2),(46,116)),
    ('C',(46,116),(44,140),(60,118),(96,106)),
    ('L',TL,RP),('L',RP,BL),('L',BL,TL),       # giro 1
    ('L',TL,RP),('L',RP,BL),('L',BL,TL),       # giro 2
    ('L',TL,RP),('L',RP,BL),                   # giro 3 (finisce in BL)
    ('C',BL,(156,196),(214,232),(150,251)),
    ('C',(150,251),(108,263),(64,255),(52,247)),
]
PEN_W = 96                     # spessore del reveal (copre la S piena)

G_MAIN = [(0,"#FF8A3D"),(0.30,"#F77737"),(0.58,"#E91E63"),(0.82,"#B22C95"),(1,"#9C27B0")]
G_DEEP = [(0,"#7A2F1B"),(0.5,"#5E1430"),(1,"#34114C")]
G_GLOW = [(0,"#FFFFFF"),(1,"#FFD9B8")]


def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")

def chaikin(pts, it):
    for _ in range(it):
        n = len(pts); out = []
        for i in range(n):
            P, Q = pts[i], pts[(i+1) % n]
            out.append((P[0]*.75+Q[0]*.25, P[1]*.75+Q[1]*.25))
            out.append((P[0]*.25+Q[0]*.75, P[1]*.25+Q[1]*.75))
        pts = out
    return pts

def polyline(pts):
    return f"M {f(pts[0][0])} {f(pts[0][1])} " + "".join(f"L {f(x)} {f(y)} " for x,y in pts[1:]) + "Z"

def round_poly(pts, radius):
    n = len(pts); R = []
    for i in range(n):
        Pp, V, N = pts[(i-1) % n], pts[i], pts[(i+1) % n]
        v1 = (Pp[0]-V[0], Pp[1]-V[1]); l1 = math.hypot(*v1)
        v2 = (N[0]-V[0], N[1]-V[1]); l2 = math.hypot(*v2)
        r = min(radius, l1*.46, l2*.46)
        R.append(((V[0]+v1[0]/l1*r, V[1]+v1[1]/l1*r), V, (V[0]+v2[0]/l2*r, V[1]+v2[1]/l2*r)))
    d = f"M {f(R[0][0][0])} {f(R[0][0][1])} "
    for i in range(n):
        A, V, B = R[i]; nA = R[(i+1) % n][0]
        d += f"Q {f(V[0])} {f(V[1])} {f(B[0])} {f(B[1])} L {f(nA[0])} {f(nA[1])} "
    return d + "Z"

def scale_about(pts, k, cx, cy):
    return [(cx+(x-cx)*k, cy+(y-cy)*k) for x,y in pts]

def cubic_pt(p0,c1,c2,p3,t):
    u = 1-t
    return (u*u*u*p0[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t*t*t*p3[0],
            u*u*u*p0[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t*t*t*p3[1])

def seg_len(s):
    if s[0] == 'L':
        return math.hypot(s[2][0]-s[1][0], s[2][1]-s[1][1])
    L = 0; prev = s[1]
    for i in range(1, 29):
        p = cubic_pt(s[1],s[2],s[3],s[4], i/28)
        L += math.hypot(p[0]-prev[0], p[1]-prev[1]); prev = p
    return L

def pen_d(segs):
    d = f"M {f(segs[0][1][0])} {f(segs[0][1][1])} "
    for s in segs:
        if s[0] == 'L':
            d += f"L {f(s[2][0])} {f(s[2][1])} "
        else:
            d += f"C {f(s[2][0])} {f(s[2][1])} {f(s[3][0])} {f(s[3][1])} {f(s[4][0])} {f(s[4][1])} "
    return d

def grad(id_, stops, x1, y1, x2, y2):
    body = "".join(f'\n      <stop offset="{o}" stop-color="{c}"/>' for o,c in stops)
    return (f'    <linearGradient id="{id_}" gradientUnits="userSpaceOnUse" '
            f'x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{body}\n    </linearGradient>')

# --- geometria derivata ---
S_PATH = polyline(chaikin(OUTER, SMOOTH))
_cx = sum(p[0] for p in PLAY) / 3
_cy = sum(p[1] for p in PLAY) / 3
PLAY_HOLE = round_poly(PLAY, PLAY_R)
PLAY_GLOW = round_poly(scale_about(PLAY, 1.07, _cx, _cy), PLAY_R)
PEN = pen_d(PEN_SEGS)
_lens = [seg_len(s) for s in PEN_SEGS]
PEN_LEN = sum(_lens)
_cum = [0]
for _l in _lens:
    _cum.append(_cum[-1] + _l)
TRI0 = _cum[2] / PEN_LEN          # quando la penna entra nel triangolo
TRI1 = _cum[9] / PEN_LEN          # quando esce
G0 = TRI0 + (TRI1 - TRI0) * 0.30  # quando il play inizia a comparire

DEFS_GRAD = "\n".join([
    grad("gMain", G_MAIN, 212, 26, 34, 258),
    grad("gDeep", G_DEEP, 212, 26, 34, 258),
    grad("gGlow", G_GLOW, 96, 106, 140, 176),
])


def build(animated):
    L = round(PEN_LEN, 1)
    if animated:
        style = f'''
  <style>
    #reveal-pen{{stroke-dasharray:{L};stroke-dashoffset:{L};
      animation:draw {DUR}s linear forwards}}
    #pen-tip{{offset-path:path('{PEN}');opacity:0;
      animation:tip {DUR}s linear forwards}}
    #play{{opacity:0;transform-origin:{_cx:.0f}px {_cy:.0f}px;
      animation:pop {DUR}s ease-out forwards}}
    @keyframes draw{{to{{stroke-dashoffset:0}}}}
    @keyframes tip{{
      0%{{offset-distance:0%;opacity:0}}
      3%{{opacity:1}} 95%{{opacity:1}}
      100%{{offset-distance:100%;opacity:0}}}}
    @keyframes pop{{
      0%,{G0*100:.1f}%{{opacity:0;transform:scale(.6)}}
      {TRI1*100:.1f}%{{opacity:1;transform:scale(1.12)}}
      {min(TRI1*100+9,99):.1f}%,100%{{opacity:1;transform:scale(1)}}}}
  </style>'''
        reveal_open = '  <g mask="url(#revealMask)">\n'
        reveal_close = '  </g>\n'
        reveal_def = (f'    <mask id="revealMask" maskUnits="userSpaceOnUse" x="-30" y="-30" '
                      f'width="{VB_W+60}" height="{VB_H+60}">\n'
                      f'      <path id="reveal-pen" d="{PEN}" fill="none" stroke="#fff" '
                      f'stroke-width="{PEN_W}" stroke-linecap="round" stroke-linejoin="round"/>\n'
                      f'    </mask>\n')
        play_attr = ' id="play"'
        pen_tip = f'  <circle id="pen-tip" r="6.5" fill="#FFF3E3"/>\n'
    else:
        style = ""
        reveal_open = reveal_close = reveal_def = ""
        play_attr = ' id="play"'
        pen_tip = ""

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB_W} {VB_H}" role="img" aria-label="Somto">{style}
  <defs>
{DEFS_GRAD}
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="depth" x="-30%" y="-30%" width="160%" height="160%">
      <feOffset in="SourceAlpha" dx="-3.4" dy="-4.4" result="o"/>
      <feGaussianBlur in="o" stdDeviation="4" result="b"/>
      <feComposite in="SourceAlpha" in2="b" operator="out" result="band"/>
      <feFlood flood-color="#240920" flood-opacity="0.42" result="c"/>
      <feComposite in="c" in2="band" operator="in" result="sh"/>
      <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="sh"/></feMerge>
    </filter>
    <mask id="playMask" maskUnits="userSpaceOnUse" x="0" y="0" width="{VB_W}" height="{VB_H}">
      <rect x="0" y="0" width="{VB_W}" height="{VB_H}" fill="#fff"/>
      <path d="{PLAY_HOLE}" fill="#000"/>
    </mask>
{reveal_def}  </defs>

{reveal_open}    <g id="somto-mark">
      <path id="s-shadow" d="{S_PATH}" fill="#000" fill-opacity="0.32" filter="url(#soft)" transform="translate(6 12)"/>
      <path id="s-back" d="{S_PATH}" fill="url(#gDeep)" transform="translate(3 5)"/>
      <g{play_attr}>
        <path d="{PLAY_GLOW}" fill="#FFE9D6" filter="url(#glow)" opacity="0.9"/>
        <path id="play-tri" d="{PLAY_GLOW}" fill="url(#gGlow)"/>
      </g>
      <path id="s-body" d="{S_PATH}" fill="url(#gMain)" mask="url(#playMask)" filter="url(#depth)"/>
    </g>
{reveal_close}{pen_tip}</svg>
'''


if __name__ == "__main__":
    open(os.path.join(OUT_DIR, "somto-mark.svg"), "w").write(build(False))
    open(os.path.join(OUT_DIR, "somto-mark-anim.svg"), "w").write(build(True))
    print("ok: somto-mark.svg + somto-mark-anim.svg")
