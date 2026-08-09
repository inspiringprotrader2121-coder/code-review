(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Theme toggle ---------- */
  var toggle = document.getElementById('themeToggle');
  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  function syncThemeControl() {
    toggle.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
  }
  toggle.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('orvex-theme', next);
    } catch (e) {}
    syncThemeControl();
  });
  syncThemeControl();

  /* ---------- Hero review log: one-time orchestrated stream ---------- */
  var stream = document.getElementById('stream');
  var status = document.getElementById('termStatus');
  function finishStream() {
    stream.classList.add('done');
    if (status) {
      status.classList.add('done');
      status.lastChild.nodeValue = 'caught';
    }
  }
  if (reduce) {
    finishStream();
  } else {
    // start playback shortly after load
    window.setTimeout(function () {
      stream.classList.add('play');
    }, 260);
    // settle into rest state after the sequence completes (~3.7s + buffer)
    window.setTimeout(finishStream, 4100);
  }
})();
