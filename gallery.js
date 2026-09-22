const photos = [6093, 6095, 6099, 6101, 6103, 6104, 6109, 6107, 6112, 6114]
  .map((number) => `assets/gallery/classroom-${number}.jpg`);
const layers = [...document.querySelectorAll('.hero-art')];
const toggle = document.querySelector('.gallery-toggle');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (layers.length === 2 && toggle) {
  let paused = reducedMotion.matches;
  let current = 0;
  let activeLayer = 0;
  let timer;
  let pending;
  const cache = new Map();
  let queue = [];

  function nextPhoto() {
    if (!queue.length) {
      queue = photos.map((_, index) => index);
      // Fisher–Yates shuffle: show every photo once per round.
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      // Avoid repeating the photo at the boundary between rounds.
      if (queue[0] === current) {
        const j = 1 + Math.floor(Math.random() * (queue.length - 1));
        [queue[0], queue[j]] = [queue[j], queue[0]];
      }
    }
    return queue[0];
  }

  // The initial photo is already visible; include it in the first round.
  nextPhoto();
  queue = queue.filter((index) => index !== current);

  function preload(index) {
    if (!cache.has(index)) {
      const image = new Image();
      image.src = photos[index];
      cache.set(index, image.decode().then(() => true).catch(() => {
        cache.delete(index);
        return false;
      }));
    }
    return cache.get(index);
  }

  async function advance() {
    if (pending || paused || document.hidden) return;
    const request = {};
    pending = request;
    const next = nextPhoto();
    // Keep the current photo visible until the next image is fully decoded.
    const loaded = await preload(next);
    if (pending !== request) return;
    if (loaded && !paused && !document.hidden) {
      const incoming = 1 - activeLayer;
      layers[incoming].src = photos[next];
      layers[incoming].classList.add('is-active');
      layers[activeLayer].classList.remove('is-active');
      activeLayer = incoming;
    }
    // Skip unavailable photos rather than letting one broken file stop the loop.
    if (loaded) current = next;
    queue.shift();
    pending = undefined;
    void preload(nextPhoto());
  }

  function syncPlayback() {
    clearInterval(timer);
    pending = undefined;
    toggle.textContent = paused ? 'Play photos' : 'Pause photos';
    toggle.setAttribute('aria-label', paused ? 'Play background slideshow' : 'Pause background slideshow');
    if (!paused && !document.hidden) {
      void preload(nextPhoto());
      timer = setInterval(advance, 3750);
    }
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    paused = !paused;
    syncPlayback();
  });
  reducedMotion.addEventListener('change', () => {
    paused = reducedMotion.matches;
    syncPlayback();
  });
  document.addEventListener('visibilitychange', syncPlayback);
  syncPlayback();
}
