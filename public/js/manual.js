/* User-manual page behaviour. Kept as an external file because the app's
   Content-Security-Policy (script-src 'self') forbids inline scripts. */
(function () {
  // Match the app's theme when opened from inside it (?theme=light|dark);
  // otherwise fall back to the OS preference via the CSS media query.
  try {
    var t = new URLSearchParams(location.search).get('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}

  // Show the app version if reachable (best-effort; the manual works offline too).
  fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.version) { var p = document.getElementById('verPill'); if (p) p.textContent = 'v' + d.version; }
  }).catch(function () {});

  // Scroll-spy: highlight the current section in the table of contents.
  var links = Array.prototype.slice.call(document.querySelectorAll('nav.toc a'));
  var map = {}; links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.classList.remove('active'); });
          if (map[en.target.id]) map[en.target.id].classList.add('active');
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    document.querySelectorAll('section.doc').forEach(function (s) { obs.observe(s); });
  }
})();
