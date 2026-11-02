/* Read-only demo: replays recorded API responses (sample data). Nothing is saved. */
(function () {
  var M = window.__DEMO_MOCKS__ || {};
  var MSG = "This is a read-only demo with sample data. Changes aren't saved.";
  var keys = Object.keys(M);
  function resp(entry) {
    return new Response(entry.body, { status: entry.status, headers: { "Content-Type": "application/json" } });
  }
  function toast() {
    try {
      var t = document.getElementById("demo-toast");
      if (!t) { t = document.createElement("div"); t.id = "demo-toast"; document.body.appendChild(t); }
      t.textContent = MSG; t.className = "show";
      clearTimeout(t._h); t._h = setTimeout(function () { t.className = ""; }, 3200);
    } catch (e) {}
  }
  function find(method, path, search, body) {
    var exact = method + " " + path + search + (method === "GET" ? "" : " " + (body || ""));
    if (M[exact]) return M[exact];
    if (method === "GET") {
      var prefix = "GET " + path;
      var date = new URLSearchParams(search).get("date");
      var same = keys.filter(function (k) { return k === prefix || k.indexOf(prefix + "?") === 0; });
      if (date) {
        var sp = new URLSearchParams(search); var dm = same.map(function (k) { return new URLSearchParams(k.split("?")[1] || "").get("date"); }).filter(Boolean).sort();
        if (dm.length) { sp.set("date", dm[dm.length - 1]); var k2 = prefix + "?" + sp.toString(); if (M[k2]) return M[k2]; }
      }
      return same.length ? M[same[0]] : null;
    }
    if (path === "/api/recommend") {
      try {
        var b = JSON.parse(body || "{}"), n = { date: "", list: !!b.list };
        var anyRec = keys.filter(function (k) { return k.indexOf("POST /api/recommend ") === 0; })[0];
        n.date = JSON.parse(anyRec.slice("POST /api/recommend ".length)).date;
        if (b.goal) n.goal = b.goal;
        if (b.instant) n.instant = true;
        if (b.budget !== undefined && b.budget !== null) { var opts = [20, 30, 50, 100]; n.budget = opts.reduce(function (a, c) { return Math.abs(c - b.budget) < Math.abs(a - b.budget) ? c : a; }); }
        return M["POST /api/recommend " + JSON.stringify(n)] || M[anyRec];
      } catch (e) { return null; }
    }
    return null;
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, opts) {
    opts = opts || {};
    var url = new URL(typeof input === "string" ? input : input.url, location.href);
    var i = url.pathname.indexOf("/api/");
    if (i < 0) return realFetch(input, opts);
    var path = url.pathname.slice(i), method = (opts.method || "GET").toUpperCase();
    var hit = find(method, path, url.search, typeof opts.body === "string" ? opts.body : "");
    if (hit) return Promise.resolve(resp(hit));
    if (method !== "GET") { toast(); return Promise.resolve(resp({ status: 403, body: JSON.stringify({ error: MSG }) })); }
    return Promise.resolve(resp({ status: 404, body: JSON.stringify({ error: "Not available in this demo." }) }));
  };
})();
