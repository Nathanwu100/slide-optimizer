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
    const next = (current + 1) % photos.length;
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
    current = next;
    pending = undefined;
    void preload((current + 1) % photos.length);
  }

  function syncPlayback() {
    clearInterval(timer);
    pending = undefined;
    toggle.textContent = paused ? 'Play photos' : 'Pause photos';
    toggle.setAttribute('aria-label', paused ? 'Play background slideshow' : 'Pause background slideshow');
    if (!paused && !document.hidden) {
      void preload((current + 1) % photos.length);
      timer = setInterval(advance, 3000);
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
