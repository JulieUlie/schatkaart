// Schatje: a little treasure chest with googly eyes. Moods (CSS-driven): idle, think, happy, wow, sad, sleep.

const INK = '#2b1d3f';

export function mascotSVG(mood = 'idle') {
  return `<svg class="schatje" data-mood="${mood}" viewBox="-6 -8 132 122" aria-hidden="true" focusable="false">
  <ellipse cx="60" cy="107" rx="40" ry="5" fill="${INK}" opacity=".14"/>
  <g class="spark" fill="#ffd23f" stroke="${INK}" stroke-width="2" stroke-linejoin="round">
    <path d="M8 22l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>
    <path d="M112 16l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z"/>
    <path d="M116 58l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z"/>
  </g>
  <g class="body">
    <ellipse cx="36" cy="101" rx="10" ry="6" fill="#c96a26" stroke="${INK}" stroke-width="4"/>
    <ellipse cx="84" cy="101" rx="10" ry="6" fill="#c96a26" stroke="${INK}" stroke-width="4"/>
    <g class="coins" stroke="${INK}" stroke-width="3">
      <circle cx="44" cy="44" r="8" fill="#ffd23f"/><circle cx="62" cy="38" r="9" fill="#ffe27a"/><circle cx="78" cy="45" r="7" fill="#ffd23f"/>
    </g>
    <rect x="14" y="48" width="92" height="52" rx="14" fill="#f39c4a"/>
    <rect x="27" y="48" width="11" height="52" fill="#d9772f"/>
    <rect x="82" y="48" width="11" height="52" fill="#d9772f"/>
    <rect x="14" y="48" width="92" height="52" rx="14" fill="none" stroke="${INK}" stroke-width="4"/>
    <g class="lid">
      <path d="M12 52V42C12 22 34 13 60 13S108 22 108 42V52Z" fill="#ffb066" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
      <path d="M32.5 50V20M87.5 50V20" stroke="#e38a3e" stroke-width="9"/>
      <path d="M12 52V42C12 22 34 13 60 13S108 22 108 42V52Z" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
      <path d="M30 26c6-5 14-7 20-7" fill="none" stroke="#ffd6a6" stroke-width="3.5" stroke-linecap="round"/>
    </g>
    <rect x="50" y="42" width="20" height="20" rx="6" fill="#ffd23f" stroke="${INK}" stroke-width="3.5"/>
    <circle cx="60" cy="50" r="2.6" fill="${INK}"/><path d="M60 51v5" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
    <g class="eyes-open">
      <circle cx="40" cy="78" r="9.5" fill="#fff" stroke="${INK}" stroke-width="3.5"/>
      <circle cx="80" cy="78" r="9.5" fill="#fff" stroke="${INK}" stroke-width="3.5"/>
      <g class="pupils">
        <circle cx="41" cy="79" r="5" fill="${INK}"/><circle cx="81" cy="79" r="5" fill="${INK}"/>
        <circle cx="43.4" cy="76.6" r="1.8" fill="#fff"/><circle cx="83.4" cy="76.6" r="1.8" fill="#fff"/>
      </g>
    </g>
    <g class="eyes-happy" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <path d="M31 81q9-11 18 0"/><path d="M71 81q9-11 18 0"/>
    </g>
    <g class="eyes-closed" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <path d="M31 77q9 8 18 0"/><path d="M71 77q9 8 18 0"/>
    </g>
    <ellipse cx="27" cy="90" rx="6" ry="3.5" fill="#ff8fab"/>
    <ellipse cx="93" cy="90" rx="6" ry="3.5" fill="#ff8fab"/>
    <path class="mouth-smile" d="M53 88q7 7 14 0" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
    <ellipse class="mouth-wow" cx="60" cy="91" rx="5" ry="6" fill="${INK}"/>
    <path class="mouth-sad" d="M53 93q7-6 14 0" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
  </g>
  <g class="dots" fill="#fff" stroke="${INK}" stroke-width="2.5">
    <circle cx="104" cy="30" r="4"/><circle cx="113" cy="20" r="5"/><circle cx="121" cy="7" r="6"/>
  </g>
  <g class="zzz" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M100 18h9l-9 10h9"/><path d="M112 2h6l-6 7h6"/>
  </g>
</svg>`;
}

/** Replace every [data-mascot] placeholder inside root with the SVG. */
export function hydrateMascots(root = document) {
  for (const el of root.querySelectorAll('[data-mascot]')) {
    if (el.firstElementChild) continue;
    el.innerHTML = mascotSVG(el.dataset.mascot);
  }
}

export function setMood(el, mood) {
  const svg = el?.querySelector?.('.schatje') || el;
  if (svg) svg.dataset.mood = mood;
}
