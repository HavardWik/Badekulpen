(function () {
  "use strict";

  // ---------------- Setup check ----------------
  var cfg = window.__FIREBASE_CONFIG__ || {};
  var looksUnconfigured = !cfg.apiKey || cfg.apiKey === "REPLACE_ME" || !cfg.projectId || cfg.projectId === "REPLACE_ME";
  if (looksUnconfigured) {
    document.body.innerHTML =
      '<div class="setup-screen"><div class="setup-card">' +
      "<h2>Nesten klar – mangler oppsett</h2>" +
      "<p>Denne siden trenger et gratis Firebase-prosjekt før den virker (det er her badeplasser og sjekk-inn lagres, og hvor Google-innlogging styres).</p>" +
      "<p>Åpne <code>index.html</code>, finn <code>window.__FIREBASE_CONFIG__</code> nær bunnen, og lim inn konfigurasjonen fra ditt eget Firebase-prosjekt. Se <code>README.md</code> for steg-for-steg instruksjoner.</p>" +
      "</div></div>";
    return;
  }

  firebase.initializeApp(cfg);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---------------- Pure helpers (rating math, time, color) ----------------
  function aggregateRatings(checkins, spotId) {
    var mine = checkins.filter(function (c) { return c.spotId === spotId; });
    if (mine.length === 0) return { avg: null, count: 0 };
    var sum = mine.reduce(function (a, c) { return a + c.rating; }, 0);
    return { avg: sum / mine.length, count: mine.length };
  }

  function relativeTime(iso, now) {
    now = now || new Date();
    var then = new Date(iso);
    var sec = Math.round((now - then) / 1000);
    var min = Math.round(sec / 60);
    var hr = Math.round(min / 60);
    var day = Math.round(hr / 24);
    if (sec < 60) return "nå nettopp";
    if (min < 60) return min + "m siden";
    if (hr < 24) return hr + "t siden";
    if (day < 30) return day + "d siden";
    var month = Math.round(day / 30);
    if (month < 12) return month + "mnd siden";
    var yr = Math.round(month / 12);
    return yr + "år siden";
  }

  function starString(avg) {
    var r = Math.round((avg || 0) * 2) / 2;
    var full = Math.floor(r), half = r - full >= 0.5;
    var s = "";
    for (var i = 0; i < 5; i++) {
      if (i < full) s += "★"; else if (i === full && half) s += "⯨"; else s += "☆";
    }
    return s;
  }

  // Marker colours sit on satellite imagery in both light and dark theme, so
  // they're fixed bright values (kept in sync with the legend in index.html).
  function ratingColor(avg, count) {
    if (!count) return "#3FA9E0";
    if (avg >= 4.5) return "#34C17A";
    if (avg >= 3) return "#F3B23E";
    return "#E5664A";
  }

  // Resizes/compresses an image file in the browser (no upload, no server)
  // and resolves to a JPEG data: URL small enough to store directly on a
  // Firestore check-in document (which must stay under 1MB total). Rejects
  // with a short Norwegian message on failure or if it's not an image.
  var MAX_PHOTO_CHARS = 700000; // ~700KB as base64 text, comfortably under Firestore's 1MB/doc limit
  function compressImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || file.type.indexOf("image/") !== 0) {
        reject(new Error("Velg en bildefil (jpg, png e.l.)."));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Kunne ikke lese bildet.")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("Kunne ikke lese bildet.")); };
        img.onload = function () {
          var tryQuality = function (maxDim, quality) {
            var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            var w = Math.max(1, Math.round(img.width * scale));
            var h = Math.max(1, Math.round(img.height * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            return canvas.toDataURL("image/jpeg", quality);
          };
          // Step down size/quality until it fits comfortably in one Firestore doc.
          var attempts = [[1100, 0.7], [800, 0.6], [600, 0.5], [450, 0.4]];
          for (var i = 0; i < attempts.length; i++) {
            var dataUrl = tryQuality(attempts[i][0], attempts[i][1]);
            if (dataUrl.length <= MAX_PHOTO_CHARS) { resolve(dataUrl); return; }
          }
          reject(new Error("Bildet er for stort selv etter komprimering. Prøv et annet bilde."));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Norway's 15 fylker (counties), as of the 2024 structure.
  var FYLKER = ["Agder", "Akershus", "Buskerud", "Finnmark", "Innlandet",
    "Møre og Romsdal", "Nordland", "Oslo", "Rogaland", "Telemark", "Troms",
    "Trøndelag", "Vestfold", "Vestland", "Østfold"];

  // ---------------- State ----------------
  var state = {
    myUser: null,       // firebase.User | null
    spots: [],          // merged: Firestore spots + national file (minus duplicates)
    fsSpots: [],        // from Firestore
    nationalSpots: [],  // from badeplasser-norge.json (Kartverket)
    checkins: [],
    lists: [],           // this user's own lists (favorites you can share)
    view: "map",
    selectedId: null,
    placing: false,
    search: "",
    fylkeFilter: "all",
    kommuneFilter: "all",
    typeFilter: "all",
    waterFilter: "all",  // "saltvann" | "innsjo" | "elv" - badeplasser only (saunas have no water type)
    formMode: null,
    dbError: null,
    spotsLoaded: false,
    spotsError: null,   // only for loading the spots feed; shown as a status pill on the map
    sharedListId: null,   // set when viewing index.html?liste=<id>
    sharedList: null,
    sharedListMissing: false,
    sharedSpotId: null,   // set when viewing index.html?sted=<id> (a directly-shared private spot)
    _sharedSpotOpened: false,
    _pendingRating: 0,
    _pendingComment: "",
    _pendingPhoto: null,     // compressed data: URL string, or null
    _pendingPhotoError: null,
    _pendingPhotoBusy: false,
    _newSpot: null,
    _addError: null,
    _confirmDelete: null,
    _confirmDeleteSpot: null,
    _confirmDeleteList: null
  };

  var mapPaneEl = document.getElementById("mapPane");
  var sidePanel = document.getElementById("sidePanel");
  var panelBody = document.getElementById("panelBody");
  var listView = document.getElementById("listView");
  var mineView = document.getElementById("mineView");
  var listsView = document.getElementById("listsView");
  var addBanner = document.getElementById("addBanner");
  var searchBox = document.getElementById("searchBox");
  var fylkeFilterEl = document.getElementById("fylkeFilter");
  var kommuneFilterEl = document.getElementById("kommuneFilter");
  var typeFilterEl = document.getElementById("typeFilter");
  var waterFilterEl = document.getElementById("waterFilter");
  var WATER_LABELS = { saltvann: "Saltvann", innsjo: "Innsjø", elv: "Elv" };
  var WATER_TYPES = ["saltvann", "innsjo", "elv"];
  var signInBtn = document.getElementById("signInBtn");
  var signOutBtn = document.getElementById("signOutBtn");
  var viewerChip = document.getElementById("viewerChip");
  var viewerAvatar = document.getElementById("viewerAvatar");
  var viewerName = document.getElementById("viewerName");
  var sharedBanner = document.getElementById("sharedBanner");
  var sharedBannerText = document.getElementById("sharedBannerText");
  var sharedBannerClose = document.getElementById("sharedBannerClose");
  var photoLightbox = document.getElementById("photoLightbox");
  var photoLightboxImg = document.getElementById("photoLightboxImg");

  function openLightbox(src) {
    photoLightboxImg.src = src;
    photoLightbox.style.display = "flex";
  }
  function closeLightbox() {
    photoLightbox.style.display = "none";
    photoLightboxImg.src = "";
  }
  photoLightbox.addEventListener("click", closeLightbox);

  // ---------------- Auth ----------------
  signInBtn.addEventListener("click", function () {
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function (err) {
      alert("Kunne ikke logge inn: " + (err && err.message ? err.message : err));
    });
  });
  signOutBtn.addEventListener("click", function () { auth.signOut(); });

  auth.onAuthStateChanged(function (user) {
    state.authReady = true;
    state.myUser = user;
    if (user) {
      signInBtn.style.display = "none";
      viewerChip.style.display = "flex";
      viewerAvatar.src = user.photoURL || "";
      viewerName.textContent = user.displayName || "Du";
    } else {
      signInBtn.style.display = "inline-flex";
      viewerChip.style.display = "none";
    }
    subscribeLists();
    render();
  });

  function requireSignInMessage() { return "Logg inn med Google for å gjøre endringer."; }

  // ---------------- Firestore subscriptions ----------------
  function dbErrorMessage(err) {
    var code = err && err.code;
    if (code === "permission-denied") return "Du har ikke tilgang til å gjøre dette.";
    if (code === "unavailable") return "Mistet forbindelsen et øyeblikk – prøver igjen automatisk.";
    return "Noe gikk galt. Prøv igjen.";
  }

  function docsToList(snap) {
    return snap.docs.map(function (d) { var data = d.data() || {}; data.id = d.id; return data; });
  }

  db.collection("spots").onSnapshot(function (snap) {
    state.spotsSource = "sdk";
    applySpots(docsToList(snap));
  }, function (err) {
    state.dbError = dbErrorMessage(err);
    if (!state.spotsLoaded) loadViaRestFallback(); // try the plain REST route before giving up
    render();
  });

  function applySpots(list) {
    state.dbError = null;
    state.spotsLoaded = true;
    state.spotsError = null;
    state.fsSpots = list;
    mergeSpots();
  }

  // ---------------- Badeplasser fra hele Norge (static file made by importer-norge.html) ----------------
  // ~1 400 places from Kartverket. Kept as a file on GitHub Pages rather than in Firestore, so a visit doesn't
  // cost 1 400 database reads (the free plan allows 50 000 a day). Missing file = app works as before.
  var DUPLICATE_OF_EXISTING_M = 200;
  function metresBetween(a, b) {
    var dy = (a.lat - b.lat) * 111320;
    var dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function mergeSpots() {
    var fs = state.fsSpots.filter(function (f) { return typeof f.lat === "number" && typeof f.lon === "number"; });
    var national = state.nationalSpots.filter(function (n) {
      for (var i = 0; i < fs.length; i++) if (metresBetween(n, fs[i]) < DUPLICATE_OF_EXISTING_M) return false; // already on the map
      return true;
    });
    state.spots = state.fsSpots.concat(national);
    populateFylkeFilter();
    populateKommuneFilter();
    if (state.sharedSpotId && !state._sharedSpotOpened) {
      var shared = state.spots.filter(function (s) { return s.id === state.sharedSpotId; })[0];
      if (shared) {
        state._sharedSpotOpened = true;
        selectSpot(shared.id); // also flies the map to it, wherever it is
      }
    }
    render();
  }
  fetch("badeplasser-norge.json", { cache: "no-cache" }).then(function (r) {
    if (!r.ok) return null; // not uploaded yet
    return r.json();
  }).then(function (file) {
    if (!file || !Array.isArray(file.spots)) return;
    state.nationalSpots = file.spots.filter(function (s) { return s && s.id && typeof s.lat === "number" && typeof s.lon === "number"; }).map(function (s) {
      return {
        id: s.id, name: s.name, kommune: s.kommune, fylke: s.fylke, lat: s.lat, lon: s.lon,
        water: s.water, waterGuess: !!s.waterGuess, kind: s.kind,
        type: "badeplass", visibility: "public", official: true, source: "kartverket"
      };
    });
    map.attributionControl.addAttribution('Badeplasser © <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a>');
    mergeSpots();
  }).catch(function () { /* no national file - fine */ });

  // A spot is visible in the normal map/list UI to: anyone, if it's public;
  // the person who added it, always; and anyone who opened a direct
  // index.html?sted=<id> link to it, even if it's marked "bare meg". This is
  // a UI-level privacy filter (see firestore.rules: all spots are still
  // technically readable, same trust model as the "lists" feature) — good
  // enough for a friends-and-family app, not a hardened access boundary.
  function isSpotVisible(s) {
    if ((s.visibility || "public") !== "private") return true;
    if (state.myUser && s.addedBy === state.myUser.uid) return true;
    if (s.id === state.sharedSpotId) return true;
    return false;
  }

  function applyCheckins(list) {
    state.checkins = list.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    render();
  }
  db.collection("checkins").onSnapshot(function (snap) {
    state.checkinsSource = "sdk";
    applyCheckins(docsToList(snap));
  }, function (err) {
    state.dbError = dbErrorMessage(err);
    render();
  });

  function populateFylkeFilter() {
    var fylker = Array.from(new Set(state.spots.map(function (s) { return s.fylke; }).filter(Boolean))).sort();
    var current = fylkeFilterEl.value || "all";
    fylkeFilterEl.innerHTML = '<option value="all">Alle fylker</option>' +
      fylker.map(function (f) { return '<option value="' + f.replace(/"/g, "") + '">' + f + "</option>"; }).join("");
    fylkeFilterEl.value = fylker.indexOf(current) >= 0 ? current : "all";
  }

  function populateKommuneFilter() {
    var relevant = state.spots.filter(function (s) {
      return state.fylkeFilter === "all" || s.fylke === state.fylkeFilter;
    });
    var kommuner = Array.from(new Set(relevant.map(function (s) { return s.kommune; }).filter(Boolean))).sort();
    var current = kommuneFilterEl.value || "all";
    kommuneFilterEl.innerHTML = '<option value="all">Alle kommuner</option>' +
      kommuner.map(function (k) { return '<option value="' + k.replace(/"/g, "") + '">' + k + "</option>"; }).join("");
    kommuneFilterEl.value = kommuner.indexOf(current) >= 0 ? current : "all";
  }

  function visibleSpots() {
    var q = state.search.trim().toLowerCase();
    var list = state.spots;

    if (state.sharedListId) {
      if (!state.sharedList) return [];
      var idSet = {};
      (state.sharedList.spotIds || []).forEach(function (id) { idSet[id] = true; });
      list = list.filter(function (s) { return idSet[s.id]; });
    }

    return list.filter(function (s) {
      if (!isSpotVisible(s)) return false;
      if (s.id === state.sharedSpotId) return true; // a directly-shared spot always shows, regardless of filters
      if (!state.sharedListId) {
        if (state.fylkeFilter !== "all" && s.fylke !== state.fylkeFilter) return false;
        if (state.kommuneFilter !== "all" && s.kommune !== state.kommuneFilter) return false;
      }
      if (state.typeFilter !== "all" && (s.type || "badeplass") !== state.typeFilter) return false;
      if (state.waterFilter !== "all" && s.water !== state.waterFilter) return false; // saunas/unknown only under "Alle"
      if (!q) return true;
      var hay = ((s.name || "") + " " + (s.district || "") + " " + (s.kommune || "") + " " + (s.fylke || "") + " " + (s.desc || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // ---------------- Lists (favorites you can share) ----------------
  var listsUnsub = null;
  function subscribeLists() {
    if (listsUnsub) { listsUnsub(); listsUnsub = null; }
    state.lists = [];
    if (!state.myUser) { render(); return; }
    listsUnsub = db.collection("lists").where("ownerId", "==", state.myUser.uid).onSnapshot(function (snap) {
      state.lists = snap.docs.map(function (d) {
        var data = d.data() || {};
        data.id = d.id;
        return data;
      }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      render();
    }, function (err) { state.dbError = dbErrorMessage(err); render(); });
  }

  var sharedListUnsub = null;
  function subscribeSharedList(id) {
    if (sharedListUnsub) { sharedListUnsub(); sharedListUnsub = null; }
    state.sharedList = null;
    state.sharedListMissing = false;
    sharedListUnsub = db.collection("lists").doc(id).onSnapshot(function (doc) {
      state.sharedListSource = "sdk";
      applySharedList(doc.exists ? Object.assign({}, doc.data() || {}, { id: doc.id }) : null);
    }, function (err) { state.dbError = dbErrorMessage(err); render(); });
  }
  function applySharedList(data) {
    state.sharedList = data;
    state.sharedListMissing = !data;
    hasFitOnce = false; // re-fit the map to the (new) visible set
    render();
  }

  function openSharedList(id, listDataIfKnown) {
    var url = new URL(location.href);
    url.search = "";
    url.searchParams.set("liste", id);
    history.replaceState({}, "", url.toString());
    state.sharedListId = id;
    if (listDataIfKnown) { state.sharedList = listDataIfKnown; state.sharedListMissing = false; }
    subscribeSharedList(id);
    state.view = "map";
    hasFitOnce = false;
    render();
  }

  function clearSharedList() {
    if (sharedListUnsub) { sharedListUnsub(); sharedListUnsub = null; }
    state.sharedListId = null;
    state.sharedList = null;
    state.sharedListMissing = false;
    var url = new URL(location.href);
    url.searchParams.delete("liste");
    history.replaceState({}, "", url.toString());
    hasFitOnce = false;
    render();
  }

  function renderSharedBanner() {
    if (!state.sharedListId) { sharedBanner.style.display = "none"; return; }
    sharedBanner.style.display = "flex";
    if (state.sharedList) {
      var n = (state.sharedList.spotIds || []).length;
      sharedBannerText.textContent = "Viser liste “" + (state.sharedList.name || "Liste") + "” av " +
        (state.sharedList.ownerName || "en venn") + " — " + n + (n === 1 ? " badeplass" : " badeplasser");
    } else if (state.sharedListMissing) {
      sharedBannerText.textContent = "Fant ikke denne listen. Den kan være slettet.";
    } else {
      sharedBannerText.textContent = "Laster liste…";
    }
  }

  // ---------------- Leaflet map ----------------
  var DEFAULT_CENTER = [60.39, 5.32]; // Bergen
  var map = L.map("map", { zoomControl: false }).setView(DEFAULT_CENTER, 11);
  L.control.zoom({ position: "bottomleft" }).addTo(map);

  var satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" }
  ).addTo(map);

  var streets = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "© OpenStreetMap contributors" }
  );

  L.control.layers({ "Satellitt": satellite, "Kart": streets }, {}, { position: "topright" }).addTo(map);

  var markerLayer = L.layerGroup().addTo(map);
  var hasFitOnce = false;
  var pendingFlyTo = false;

  map.on("click", function (e) {
    if (!state.placing) {
      // tapping empty map leaves an open spot (but never throws away a half-filled "Ny badeplass" form)
      if (state.selectedId && state.formMode !== "add") closePanel();
      return;
    }
    exitPlacing();
    openAddForm(e.latlng.lat, e.latlng.lng);
  });

  // Markers are rebuilt on every render (search keystroke, filter, new check-in...). Only pop a marker in
  // the first time it appears, otherwise every redraw shrinks all markers to nothing for a moment.
  var poppedIn = {};
  var CLUSTER_UNTIL_ZOOM = 12;  // from this zoom and in, every spot gets its own marker
  var CLUSTER_CELL_PX = 64;     // spots closer than this on screen share a bubble
  var mapSpots = [];            // what drawMarkers() shows (the visible, filtered spots)
  var lastMarkerSig = null;

  function renderMap() {
    var visible = visibleSpots().filter(function (s) { return typeof s.lat === "number" && typeof s.lon === "number"; });
    // only rebuild markers when the set or their colours changed (render() also runs for panel clicks etc.)
    var sig = visible.map(function (s) { var a = aggregateRatings(state.checkins, s.id); return s.id + ":" + a.count + ":" + (a.avg || 0); }).join("|");
    mapSpots = visible;
    if (sig !== lastMarkerSig) { lastMarkerSig = sig; drawMarkers(); }

    if (pendingFlyTo && visible.length) {
      pendingFlyTo = false;
      var flyBounds = L.latLngBounds(visible.filter(function (s) { return typeof s.lat === "number"; }).map(function (s) { return [s.lat, s.lon]; }));
      if (flyBounds.isValid()) { map.flyToBounds(flyBounds.pad(0.35), { maxZoom: 13, duration: 0.7 }); hasFitOnce = true; }
    } else if (!hasFitOnce && visible.length) {
      var bounds = L.latLngBounds(visible.filter(function (s) { return typeof s.lat === "number"; }).map(function (s) { return [s.lat, s.lon]; }));
      if (bounds.isValid()) { map.fitBounds(bounds.pad(0.25)); hasFitOnce = true; }
    }
  }

  function spotMarker(s) {
    var agg = aggregateRatings(state.checkins, s.id);
    var color = ratingColor(agg.avg, agg.count);
    var pop = !poppedIn[s.id];
    poppedIn[s.id] = true;
    var marker;
    if (s.type === "sauna") {
      marker = L.marker([s.lat, s.lon], { icon: L.divIcon({
        className: "sauna-marker",
        html: '<div class="sauna-marker-inner' + (pop ? ' marker-pop-in' : '') + '" style="background:' + color + '">♨️</div>',
        iconSize: [32, 32], iconAnchor: [16, 16]
      }) });
    } else {
      var d = 18 + 2 * Math.min(agg.count, 7);
      marker = L.marker([s.lat, s.lon], { icon: L.divIcon({
        className: "spot-marker",
        html: '<div class="spot-dot' + (pop ? ' marker-pop-in' : '') + '" style="background:' + color + '"></div>',
        iconSize: [d, d], iconAnchor: [d / 2, d / 2]
      }) });
    }
    marker.on("click", function () { selectSpot(s.id); });
    return marker;
  }

  function clusterMarker(group) {
    var lat = 0, lon = 0;
    group.forEach(function (s) { lat += s.lat; lon += s.lon; });
    var n = group.length, d = n < 10 ? 36 : n < 100 ? 42 : 50;
    var marker = L.marker([lat / n, lon / n], { icon: L.divIcon({
      className: "cluster-marker",
      html: '<div class="cluster-bubble">' + n + "</div>",
      iconSize: [d, d], iconAnchor: [d / 2, d / 2]
    }) });
    marker.on("click", function () {
      var b = L.latLngBounds(group.map(function (s) { return [s.lat, s.lon]; }));
      map.flyToBounds(b.pad(0.3), { maxZoom: Math.max(CLUSTER_UNTIL_ZOOM + 1, map.getZoom() + 2), duration: 0.6 });
    });
    return marker;
  }

  function drawMarkers() {
    markerLayer.clearLayers();
    var zoom = map.getZoom();
    var area = map.getBounds().pad(0.5);
    var inView = mapSpots.filter(function (s) { return area.contains([s.lat, s.lon]); });
    if (zoom >= CLUSTER_UNTIL_ZOOM) {
      inView.forEach(function (s) { spotMarker(s).addTo(markerLayer); });
      return;
    }
    var cells = {}, order = [];
    inView.forEach(function (s) {
      var pt = map.project([s.lat, s.lon], zoom);
      var key = Math.floor(pt.x / CLUSTER_CELL_PX) + ":" + Math.floor(pt.y / CLUSTER_CELL_PX);
      if (!cells[key]) { cells[key] = []; order.push(key); }
      cells[key].push(s);
    });
    order.forEach(function (k) {
      var g = cells[k];
      (g.length === 1 ? spotMarker(g[0]) : clusterMarker(g)).addTo(markerLayer);
    });
  }
  map.on("zoomend moveend", drawMarkers);

  function enterPlacing() {
    state.placing = true;
    state.view = "map";
    addBanner.style.display = "flex";
    document.getElementById("map").style.cursor = "crosshair";
    render();
  }
  function exitPlacing() {
    state.placing = false;
    addBanner.style.display = "none";
    document.getElementById("map").style.cursor = "";
    mapPaneEl.classList.remove("placing");
  }

  function selectSpot(id) {
    state.selectedId = id;
    state.formMode = null;
    state.view = "map";
    hasFitOnce = true; // a deliberate selection wins over the initial "show everything" fit
    sidePanel.classList.add("open");
    render();
    var spot = state.spots.filter(function (s) { return s.id === id; })[0];
    if (spot) zoomToSpot(spot);
  }

  // Fly to a spot. Never zooms *out* if you're already closer than 15. On
  // phones the details sheet covers the bottom of the map, so aim a bit lower
  // to land the spot in the visible area above the sheet.
  function zoomToSpot(spot) {
    if (typeof spot.lat !== "number" || typeof spot.lon !== "number") return;
    setTimeout(function () { // after render() has made the map visible again (e.g. coming from the list)
      map.invalidateSize();
      var zoom = Math.max(map.getZoom(), 15);
      var target = L.latLng(spot.lat, spot.lon);
      var box = map.getContainer().getBoundingClientRect();
      var top = mapToolbar ? Math.max(0, mapToolbar.getBoundingClientRect().bottom - box.top) : 0;
      var bottom = box.height;
      if (window.matchMedia("(max-width: 820px)").matches) {
        bottom = Math.min(bottom, (window.innerHeight - sidePanel.offsetHeight) - box.top); // sheet may still be sliding in
      }
      if (bottom - top > 40) {
        var shift = box.height / 2 - (top + bottom) / 2;
        target = map.unproject(map.project(target, zoom).add([0, shift]), zoom);
      }
      map.flyTo(target, zoom, { duration: 0.8 });
    }, 0);
  }

  // ---------------- Rendering ----------------
  function render() {
    renderFilterCount();
    renderMapStatus();
    renderSharedBanner();
    renderTabs();
    renderMap();
    if (state.view === "map") {
      mapPaneEl.style.display = "block"; sidePanel.style.display = ""; // CSS hides it on desktop until a spot is open
      listView.style.display = "none"; mineView.style.display = "none"; listsView.style.display = "none";
      setTimeout(function () { map.invalidateSize(); }, 0);
    } else if (state.view === "list") {
      mapPaneEl.style.display = "none"; sidePanel.style.display = "";
      listView.style.display = "block"; mineView.style.display = "none"; listsView.style.display = "none";
      renderList();
    } else if (state.view === "lists") {
      mapPaneEl.style.display = "none"; sidePanel.style.display = "none";
      listView.style.display = "none"; mineView.style.display = "none"; listsView.style.display = "block";
      renderLists();
    } else {
      mapPaneEl.style.display = "none"; sidePanel.style.display = "none";
      listView.style.display = "none"; mineView.style.display = "block"; listsView.style.display = "none";
      renderMine();
    }
    renderPanel();
    // phones: hide the floating add button while the details sheet is open or while placing a new spot
    mapPaneEl.classList.toggle("panel-open", sidePanel.classList.contains("open"));
    mapPaneEl.classList.toggle("placing", !!state.placing);
  }

  function renderMapStatus() {
    var el = document.getElementById("mapStatus");
    if (!el) return;
    if (state.spotsError) { el.textContent = state.spotsError; el.className = "map-status error"; el.hidden = false; }
    else if (!state.spotsLoaded) { el.textContent = "Laster badeplasser…"; el.className = "map-status"; el.hidden = false; }
    else { el.hidden = true; }
  }

  function renderTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".view-tabs button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === state.view);
    });
  }

  function renderPanel() {
    renderPanelContent();
    // the close row (✕, and the drag handle on phones) only when something is open
    document.getElementById("panelBar").hidden = !!panelBody.querySelector(".panel-empty");
  }

  function renderPanelContent() {
    var spot = state.spots.filter(function (s) { return s.id === state.selectedId; })[0];
    if (spot && !isSpotVisible(spot)) spot = null;
    panelBody.innerHTML = "";

    if (state.formMode === "add") {
      panelBody.appendChild(buildAddForm());
      sidePanel.classList.add("open");
      return;
    }

    if (!spot) {
      var empty = document.createElement("div");
      empty.className = "panel-empty";
      empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11Z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="1.5"/></svg>';
      var p = document.createElement("div");
      p.textContent = "Velg en badeplass i kartet eller listen for å se detaljer, sjekke inn og lese vurderinger.";
      empty.appendChild(p);
      panelBody.appendChild(empty);
      sidePanel.classList.remove("open");
      return;
    }

    sidePanel.classList.add("open");
    var wrap = document.createElement("div");
    wrap.className = "panel-content";

    if (state.dbError) {
      var banner = document.createElement("div");
      banner.className = "inline-banner";
      banner.textContent = state.dbError;
      wrap.appendChild(banner);
    }

    var meta = document.createElement("div");
    meta.className = "spot-meta";
    var cityChip = document.createElement("span");
    cityChip.className = "chip";
    cityChip.textContent = (spot.district ? spot.district + ", " : "") + (spot.kommune || "");
    meta.appendChild(cityChip);
    if (spot.fylke) {
      var fylkeChip = document.createElement("span");
      fylkeChip.className = "chip";
      fylkeChip.textContent = spot.fylke;
      meta.appendChild(fylkeChip);
    }
    if (spot.type === "sauna") {
      var sc = document.createElement("span");
      sc.className = "chip official";
      sc.textContent = "♨️ Sauna";
      meta.appendChild(sc);
    }
    if (spot.type !== "sauna" && WATER_LABELS[spot.water]) {
      var wc = document.createElement("span");
      wc.className = "chip water";
      wc.textContent = WATER_LABELS[spot.water] + (spot.waterGuess ? " (anslått)" : "");
      meta.appendChild(wc);
    }
    if (spot.source === "kartverket") {
      var kc = document.createElement("span");
      kc.className = "chip official";
      kc.textContent = "Fra Kartverket";
      meta.appendChild(kc);
    } else if (spot.official) {
      var oc = document.createElement("span");
      oc.className = "chip official";
      oc.textContent = spot.type === "sauna" ? "✓ Offentlig sauna" : "✓ Kommunal badeplass";
      meta.appendChild(oc);
    }
    if (spot.visibility === "private") {
      var pc = document.createElement("span");
      pc.className = "chip";
      pc.textContent = "🔒 Privat (delt via lenke)";
      meta.appendChild(pc);
    }
    wrap.appendChild(meta);

    var title = document.createElement("h2");
    title.className = "spot-title";
    title.textContent = spot.name || "Badeplass";
    wrap.appendChild(title);

    if (spot.desc) {
      var desc = document.createElement("div");
      desc.className = "spot-desc";
      desc.textContent = spot.desc;
      wrap.appendChild(desc);
    } else if (spot.source === "kartverket") {
      var kdesc = document.createElement("div");
      kdesc.className = "spot-desc";
      kdesc.textContent = (spot.kind === "strand" ? "Strand" : "Badeplass") + " registrert i Kartverkets stedsnavnregister. Ingen beskrivelse ennå – sjekk inn og fortell hvordan det var!";
      wrap.appendChild(kdesc);
    }

    var agg = aggregateRatings(state.checkins, spot.id);
    var rs = document.createElement("div");
    rs.className = "rating-summary";
    var starsEl = document.createElement("span");
    starsEl.className = "stars";
    starsEl.textContent = starString(agg.avg || 0);
    rs.appendChild(starsEl);
    if (agg.count) {
      var num = document.createElement("span");
      num.className = "rating-num";
      num.textContent = agg.avg.toFixed(1);
      rs.appendChild(num);
      var cnt = document.createElement("span");
      cnt.className = "rating-count";
      cnt.textContent = agg.count + " sjekk-inn";
      rs.appendChild(cnt);
    } else {
      var cnt2 = document.createElement("span");
      cnt2.className = "rating-count";
      cnt2.textContent = "Ingen vurderinger enda – bli den første!";
      rs.appendChild(cnt2);
    }
    wrap.appendChild(rs);

    var listLbl = document.createElement("div");
    listLbl.className = "section-label";
    listLbl.textContent = "Mine lister";
    wrap.appendChild(listLbl);
    if (state.myUser) {
      wrap.appendChild(buildAddToListBox(spot));
    } else {
      var listHint = document.createElement("div");
      listHint.className = "rating-count";
      listHint.style.marginBottom = "14px";
      listHint.textContent = "Logg inn for å lagre denne i en liste du kan dele.";
      wrap.appendChild(listHint);
    }

    if (spot.facilities && spot.facilities.length) {
      var fl = document.createElement("div");
      fl.className = "facility-list";
      spot.facilities.forEach(function (f) {
        var c = document.createElement("span");
        c.className = "chip";
        c.textContent = f;
        fl.appendChild(c);
      });
      wrap.appendChild(fl);
    }

    if (!spot.official && spot.addedByName) {
      var addedLbl = document.createElement("div");
      addedLbl.className = "rating-count";
      addedLbl.style.marginBottom = "14px";
      addedLbl.textContent = "Lagt til av " + spot.addedByName;
      wrap.appendChild(addedLbl);
    }

    var ciLabel = document.createElement("div");
    ciLabel.className = "section-label";
    ciLabel.textContent = "Sjekk inn";
    wrap.appendChild(ciLabel);
    wrap.appendChild(buildCheckinForm(spot));

    var recent = state.checkins.filter(function (c) { return c.spotId === spot.id; }).slice(0, 8);
    var rLabel = document.createElement("div");
    rLabel.className = "section-label";
    rLabel.textContent = "Siste sjekk-inn";
    wrap.appendChild(rLabel);
    if (!recent.length) {
      var none = document.createElement("div");
      none.className = "rating-count";
      none.textContent = "Ingen enda.";
      wrap.appendChild(none);
    } else {
      recent.forEach(function (c) { wrap.appendChild(buildCheckinRow(c)); });
    }

    if (state.myUser && spot.addedBy && spot.addedBy === state.myUser.uid) {
      var manageLbl = document.createElement("div");
      manageLbl.className = "section-label";
      manageLbl.textContent = "Administrer";
      wrap.appendChild(manageLbl);
      if (!spot.official && spot.type !== "sauna") wrap.appendChild(buildWaterEditor(spot));
      wrap.appendChild(buildShareSpotControl(spot));
      if (!spot.official) wrap.appendChild(buildDeleteSpotControl(spot));
    }

    panelBody.appendChild(wrap);
  }

  function buildWaterToggle(id, current, onPick) {
    var row = document.createElement("div");
    row.className = "type-toggle";
    row.id = id;
    WATER_TYPES.forEach(function (w) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = WATER_LABELS[w];
      b.className = current === w ? "on" : "";
      b.addEventListener("click", function () { onPick(w); });
      row.appendChild(b);
    });
    return row;
  }

  function buildWaterEditor(spot) {
    var box = document.createElement("div");
    box.style.marginBottom = "12px";
    var lbl = document.createElement("div");
    lbl.className = "field-label";
    lbl.style.marginTop = "0";
    lbl.textContent = spot.water ? "Vanntype" : "Vanntype – ikke valgt ennå";
    box.appendChild(lbl);
    box.appendChild(buildWaterToggle("waterEdit", spot.water, function (w) {
      var before = spot.water;
      spot.water = w; // show it right away; the live listener confirms it
      renderPanel();
      db.collection("spots").doc(spot.id).update({ water: w }).catch(function (err) {
        spot.water = before; state.dbError = dbErrorMessage(err); render();
      });
    }));
    return box;
  }

  function buildCheckinForm(spot) {
    var box = document.createElement("div");
    var myRating = state._pendingRating || 0;
    var stars = document.createElement("div");
    stars.className = "star-picker";
    for (var i = 1; i <= 5; i++) {
      (function (i) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = "★";
        if (i <= myRating) b.classList.add("on");
        b.addEventListener("click", function () { state._pendingRating = i; renderPanel(); });
        stars.appendChild(b);
      })(i);
    }
    box.appendChild(stars);

    var comment = document.createElement("textarea");
    comment.placeholder = "Hvordan var det? (valgfritt)";
    comment.rows = 2;
    comment.value = state._pendingComment || "";
    comment.addEventListener("input", function () { state._pendingComment = comment.value; });
    box.appendChild(comment);

    var photoBox = document.createElement("div");
    photoBox.className = "photo-picker";
    if (state._pendingPhoto) {
      var preview = document.createElement("img");
      preview.className = "photo-preview";
      preview.src = state._pendingPhoto;
      photoBox.appendChild(preview);
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-ghost btn-sm";
      removeBtn.textContent = "Fjern bilde";
      removeBtn.addEventListener("click", function () { state._pendingPhoto = null; renderPanel(); });
      photoBox.appendChild(removeBtn);
    } else {
      var fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        state._pendingPhotoBusy = true; state._pendingPhotoError = null; renderPanel();
        compressImageFile(file).then(function (dataUrl) {
          state._pendingPhoto = dataUrl; state._pendingPhotoBusy = false; renderPanel();
        }).catch(function (err) {
          state._pendingPhotoError = err.message || "Kunne ikke bruke bildet.";
          state._pendingPhotoBusy = false; renderPanel();
        });
      });
      photoBox.appendChild(fileInput);
      var photoBtn = document.createElement("button");
      photoBtn.type = "button";
      photoBtn.className = "btn btn-sm";
      photoBtn.disabled = !!state._pendingPhotoBusy;
      photoBtn.textContent = state._pendingPhotoBusy ? "Behandler bilde…" : "📷 Legg til bilde";
      photoBtn.addEventListener("click", function () { fileInput.click(); });
      photoBox.appendChild(photoBtn);
      if (state._pendingPhotoError) {
        var perr = document.createElement("div");
        perr.className = "facility-input-hint";
        perr.style.color = "var(--low)";
        perr.textContent = state._pendingPhotoError;
        photoBox.appendChild(perr);
      }
    }
    box.appendChild(photoBox);

    var row = document.createElement("div");
    row.style.marginTop = "10px";
    var submit = document.createElement("button");
    submit.className = "btn btn-warm";
    submit.textContent = "Sjekk inn";
    submit.disabled = !state.myUser || !myRating || state._pendingPhotoBusy;
    submit.addEventListener("click", function () {
      if (!state.myUser) return;
      submit.disabled = true;
      var data = {
        spotId: spot.id,
        userId: state.myUser.uid,
        userName: state.myUser.displayName || "En venn",
        userPhoto: state.myUser.photoURL || "",
        rating: state._pendingRating,
        comment: (state._pendingComment || "").trim().slice(0, 500),
        createdAt: new Date().toISOString()
      };
      if (state._pendingPhoto) data.photo = state._pendingPhoto;
      db.collection("checkins").add(data).then(function () {
        state._pendingRating = 0; state._pendingComment = ""; state._pendingPhoto = null; state._pendingPhotoError = null;
        render();
      }).catch(function (err) { state.dbError = dbErrorMessage(err); submit.disabled = false; render(); });
    });
    row.appendChild(submit);
    if (!state.myUser) {
      var hint = document.createElement("span");
      hint.className = "facility-input-hint";
      hint.style.marginLeft = "10px";
      hint.textContent = requireSignInMessage();
      row.appendChild(hint);
    }
    box.appendChild(row);
    return box;
  }

  function buildCheckinRow(c) {
    var row = document.createElement("div");
    row.className = "checkin-row";
    var img = document.createElement("img");
    img.src = c.userPhoto || "";
    img.alt = "";
    row.appendChild(img);

    var body = document.createElement("div");
    body.className = "checkin-body";
    var head = document.createElement("div");
    head.className = "checkin-head";
    var name = document.createElement("span");
    name.className = "checkin-name";
    name.textContent = c.userName || "En venn";
    head.appendChild(name);
    var stars = document.createElement("span");
    stars.className = "checkin-stars";
    stars.textContent = starString(c.rating);
    head.appendChild(stars);
    var time = document.createElement("span");
    time.className = "checkin-time";
    time.textContent = relativeTime(c.createdAt);
    head.appendChild(time);
    body.appendChild(head);

    if (c.comment) {
      var com = document.createElement("div");
      com.className = "checkin-comment";
      com.textContent = c.comment;
      body.appendChild(com);
    }

    if (c.photo) {
      var photo = document.createElement("img");
      photo.className = "checkin-photo";
      photo.src = c.photo;
      photo.alt = "";
      photo.loading = "lazy";
      photo.addEventListener("click", function () { openLightbox(c.photo); });
      body.appendChild(photo);
    }

    if (state.myUser && c.userId === state.myUser.uid) {
      var del = document.createElement("button");
      del.className = "checkin-del";
      del.textContent = state._confirmDelete === c.id ? "Sikker? Trykk igjen for å slette" : "Slett";
      del.addEventListener("click", function () {
        if (state._confirmDelete === c.id) {
          db.collection("checkins").doc(c.id).delete().then(function () { state._confirmDelete = null; render(); });
        } else { state._confirmDelete = c.id; render(); }
      });
      body.appendChild(del);
    }

    row.appendChild(body);
    return row;
  }

  function buildShareSpotControl(spot) {
    var box = document.createElement("div");
    box.style.marginBottom = "8px";
    var btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.textContent = spot.visibility === "private" ? "Del lenke til dette stedet" : "Del lenke";
    btn.addEventListener("click", function () {
      var url = new URL(location.href);
      url.search = "";
      url.searchParams.set("sted", spot.id);
      var link = url.toString();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () {
          btn.textContent = "Lenke kopiert!";
          setTimeout(function () { btn.textContent = spot.visibility === "private" ? "Del lenke til dette stedet" : "Del lenke"; }, 2000);
        }).catch(function () { window.prompt("Kopier denne lenken:", link); });
      } else {
        window.prompt("Kopier denne lenken:", link);
      }
    });
    box.appendChild(btn);
    if (spot.visibility === "private") {
      var hint = document.createElement("div");
      hint.className = "facility-input-hint";
      hint.textContent = "Alle som åpner denne lenken kan se stedet, selv om det bare er synlig for deg i kartet ellers.";
      box.appendChild(hint);
    }
    return box;
  }

  function buildDeleteSpotControl(spot) {
    var box = document.createElement("div");
    var btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.textContent = state._confirmDeleteSpot === spot.id ? "Sikker? Trykk igjen for å fjerne" : "Fjern badeplass";
    btn.addEventListener("click", function () {
      if (state._confirmDeleteSpot === spot.id) {
        db.collection("spots").doc(spot.id).delete().then(function () {
          state.selectedId = null; state._confirmDeleteSpot = null; render();
        });
      } else { state._confirmDeleteSpot = spot.id; render(); }
    });
    box.appendChild(btn);
    return box;
  }

  function buildAddToListBox(spot) {
    var box = document.createElement("div");
    box.className = "list-picker";

    if (!state.lists.length) {
      var hint = document.createElement("div");
      hint.className = "rating-count";
      hint.style.marginBottom = "8px";
      hint.textContent = "Du har ingen lister enda — lag en under.";
      box.appendChild(hint);
    } else {
      state.lists.forEach(function (l) {
        var row = document.createElement("label");
        row.className = "list-picker-row";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = (l.spotIds || []).indexOf(spot.id) !== -1;
        cb.addEventListener("change", function () {
          var op = cb.checked
            ? firebase.firestore.FieldValue.arrayUnion(spot.id)
            : firebase.firestore.FieldValue.arrayRemove(spot.id);
          db.collection("lists").doc(l.id).update({ spotIds: op }).catch(function (err) {
            state.dbError = dbErrorMessage(err); render();
          });
        });
        row.appendChild(cb);
        var span = document.createElement("span");
        span.textContent = l.name + " (" + (l.spotIds || []).length + ")";
        row.appendChild(span);
        box.appendChild(row);
      });
    }

    var newRow = document.createElement("div");
    newRow.style.cssText = "display:flex;gap:6px;margin-top:8px;";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Ny liste…";
    input.style.flex = "1";
    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-sm";
    addBtn.textContent = "Lag";
    addBtn.addEventListener("click", function () {
      var name = input.value.trim();
      if (!name) return;
      addBtn.disabled = true;
      db.collection("lists").add({
        name: name.slice(0, 80),
        ownerId: state.myUser.uid,
        ownerName: state.myUser.displayName || "en venn",
        spotIds: [spot.id],
        createdAt: new Date().toISOString()
      }).then(function () {
        input.value = ""; addBtn.disabled = false; render();
      }).catch(function (err) { state.dbError = dbErrorMessage(err); addBtn.disabled = false; render(); });
    });
    newRow.appendChild(input);
    newRow.appendChild(addBtn);
    box.appendChild(newRow);
    return box;
  }

  function renderLists() {
    listsView.innerHTML = "";
    if (!state.myUser) {
      var e = document.createElement("div");
      e.className = "panel-empty";
      e.textContent = "Logg inn for å lage og dele dine egne lister over favoritt-badeplasser.";
      listsView.appendChild(e);
      return;
    }

    var toolbar = document.createElement("div");
    toolbar.className = "list-toolbar";
    var note = document.createElement("div");
    note.className = "rating-count";
    note.textContent = state.lists.length + (state.lists.length === 1 ? " liste" : " lister");
    toolbar.appendChild(note);
    listsView.appendChild(toolbar);

    var newBox = document.createElement("div");
    newBox.style.cssText = "display:flex;gap:8px;margin-bottom:22px;max-width:420px;flex-wrap:wrap;";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Navn på ny liste, f.eks. Favoritter";
    input.style.flex = "1";
    input.style.minWidth = "180px";
    var btn = document.createElement("button");
    btn.className = "btn btn-accent";
    btn.textContent = "Lag liste";
    btn.addEventListener("click", function () {
      var name = input.value.trim();
      if (!name) return;
      btn.disabled = true;
      db.collection("lists").add({
        name: name.slice(0, 80),
        ownerId: state.myUser.uid,
        ownerName: state.myUser.displayName || "en venn",
        spotIds: [],
        createdAt: new Date().toISOString()
      }).then(function () {
        input.value = ""; btn.disabled = false;
      }).catch(function (err) { state.dbError = dbErrorMessage(err); btn.disabled = false; render(); });
    });
    newBox.appendChild(input);
    newBox.appendChild(btn);
    listsView.appendChild(newBox);

    if (!state.lists.length) {
      var e2 = document.createElement("div");
      e2.className = "panel-empty";
      e2.textContent = 'Du har ingen lister enda. Lag en over, eller trykk "Mine lister" på en badeplass i kartet.';
      listsView.appendChild(e2);
      return;
    }

    state.lists.forEach(function (l) { listsView.appendChild(buildListCard(l)); });
  }

  function buildListCard(l) {
    var card = document.createElement("div");
    card.className = "list-card";

    var head = document.createElement("div");
    head.className = "list-card-head";
    var name = document.createElement("div");
    name.className = "list-card-name";
    name.textContent = l.name;
    head.appendChild(name);
    var count = document.createElement("span");
    count.className = "rating-count";
    var n = (l.spotIds || []).length;
    count.textContent = n + (n === 1 ? " badeplass" : " badeplasser");
    head.appendChild(count);
    card.appendChild(head);

    var spotNames = (l.spotIds || []).map(function (id) {
      var s = state.spots.filter(function (sp) { return sp.id === id; })[0];
      return s ? s.name : null;
    }).filter(Boolean);
    var namesEl = document.createElement("div");
    namesEl.className = "rating-count";
    namesEl.style.cssText = "margin:6px 0 12px; line-height:1.5;";
    namesEl.textContent = spotNames.length ? spotNames.join(", ") : "Ingen badeplasser lagt til enda.";
    card.appendChild(namesEl);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";

    var viewBtn = document.createElement("button");
    viewBtn.className = "btn btn-sm";
    viewBtn.textContent = "Vis i kart";
    viewBtn.addEventListener("click", function () { openSharedList(l.id, l); });
    actions.appendChild(viewBtn);

    var shareBtn = document.createElement("button");
    shareBtn.className = "btn btn-sm";
    shareBtn.textContent = "Del lenke";
    shareBtn.addEventListener("click", function () {
      var url = new URL(location.href);
      url.search = "";
      url.searchParams.set("liste", l.id);
      var link = url.toString();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () {
          shareBtn.textContent = "Lenke kopiert!";
          setTimeout(function () { shareBtn.textContent = "Del lenke"; }, 2000);
        }).catch(function () { window.prompt("Kopier denne lenken:", link); });
      } else {
        window.prompt("Kopier denne lenken:", link);
      }
    });
    actions.appendChild(shareBtn);

    var delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-ghost";
    delBtn.textContent = state._confirmDeleteList === l.id ? "Sikker? Trykk igjen for å slette" : "Slett liste";
    delBtn.addEventListener("click", function () {
      if (state._confirmDeleteList === l.id) {
        db.collection("lists").doc(l.id).delete().then(function () {
          state._confirmDeleteList = null;
          if (state.sharedListId === l.id) clearSharedList();
          render();
        });
      } else { state._confirmDeleteList = l.id; render(); }
    });
    actions.appendChild(delBtn);

    card.appendChild(actions);
    return card;
  }

  function openAddForm(lat, lon) {
    state.formMode = "add";
    var defaultFylke = state.fylkeFilter !== "all" ? state.fylkeFilter : "";
    var defaultKommune = state.kommuneFilter !== "all" ? state.kommuneFilter : "";
    state._newSpot = { lat: lat, lon: lon, name: "", fylke: defaultFylke, kommune: defaultKommune, type: "badeplass", visibility: "public", desc: "", facilities: "" };
    state._addError = null;
    state.selectedId = null;
    sidePanel.classList.add("open");
    render();
  }

  function buildAddForm() {
    var wrap = document.createElement("div");
    wrap.className = "panel-content";

    var title = document.createElement("h2");
    title.className = "spot-title";
    title.style.marginTop = "4px";
    title.textContent = "Ny badeplass";
    wrap.appendChild(title);

    var coord = document.createElement("div");
    coord.className = "rating-count";
    coord.style.marginBottom = "8px";
    coord.textContent = state._newSpot.lat.toFixed(5) + ", " + state._newSpot.lon.toFixed(5);
    wrap.appendChild(coord);

    function field(labelText, key, placeholder) {
      var lbl = document.createElement("label");
      lbl.className = "field-label";
      lbl.textContent = labelText;
      wrap.appendChild(lbl);
      var input = document.createElement("input");
      input.type = "text";
      input.placeholder = placeholder || "";
      input.value = state._newSpot[key] || "";
      input.addEventListener("input", function () { state._newSpot[key] = input.value; });
      wrap.appendChild(input);
      return input;
    }

    field("Navn", "name", "F.eks. Lille Lungegårdsvann");

    var fylkeLbl = document.createElement("label");
    fylkeLbl.className = "field-label";
    fylkeLbl.textContent = "Fylke";
    wrap.appendChild(fylkeLbl);
    var fylkeSel = document.createElement("select");
    fylkeSel.innerHTML = '<option value="">Velg fylke…</option>' +
      FYLKER.map(function (f) {
        return '<option value="' + f + '"' + (state._newSpot.fylke === f ? " selected" : "") + ">" + f + "</option>";
      }).join("");
    fylkeSel.addEventListener("change", function () { state._newSpot.fylke = fylkeSel.value; });
    wrap.appendChild(fylkeSel);

    field("Kommune", "kommune", "F.eks. Bergen");

    var typeLbl = document.createElement("label");
    typeLbl.className = "field-label";
    typeLbl.textContent = "Type";
    wrap.appendChild(typeLbl);
    var typeRow = document.createElement("div");
    typeRow.className = "type-toggle";
    [["badeplass", "Badeplass"], ["sauna", "♨️ Sauna"]].forEach(function (pair, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = pair[1];
      var isOn = (state._newSpot.type || "badeplass") === pair[0];
      b.className = isOn ? (i === 1 ? "on warm" : "on") : "";
      b.addEventListener("click", function () { state._newSpot.type = pair[0]; renderPanel(); });
      typeRow.appendChild(b);
    });
    wrap.appendChild(typeRow);

    if ((state._newSpot.type || "badeplass") === "badeplass") {
      var waterLbl = document.createElement("label");
      waterLbl.className = "field-label";
      waterLbl.textContent = "Vann";
      wrap.appendChild(waterLbl);
      wrap.appendChild(buildWaterToggle("waterToggle", state._newSpot.water, function (w) {
        state._newSpot.water = w; state._addError = null; renderPanel();
      }));
    }

    var visLbl = document.createElement("label");
    visLbl.className = "field-label";
    visLbl.textContent = "Hvem skal se dette stedet?";
    wrap.appendChild(visLbl);
    var visRow = document.createElement("div");
    visRow.className = "type-toggle";
    [["public", "Synlig for alle"], ["private", "🔒 Bare meg"]].forEach(function (pair, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = pair[1];
      var isOn = (state._newSpot.visibility || "public") === pair[0];
      b.className = isOn ? (i === 1 ? "on warm" : "on") : "";
      b.addEventListener("click", function () { state._newSpot.visibility = pair[0]; renderPanel(); });
      visRow.appendChild(b);
    });
    wrap.appendChild(visRow);
    var visHint = document.createElement("div");
    visHint.className = "facility-input-hint";
    visHint.style.marginBottom = "4px";
    visHint.textContent = (state._newSpot.visibility === "private")
      ? "Bare du ser dette i kartet ditt — men du kan dele en lenke til det med andre senere."
      : "Vises for alle som bruker siden.";
    wrap.appendChild(visHint);

    var descLbl = document.createElement("label");
    descLbl.className = "field-label";
    descLbl.textContent = "Beskrivelse";
    wrap.appendChild(descLbl);
    var descArea = document.createElement("textarea");
    descArea.rows = 3;
    descArea.placeholder = "Hva bør man vite før man bader her?";
    descArea.value = state._newSpot.desc || "";
    descArea.addEventListener("input", function () { state._newSpot.desc = descArea.value; });
    wrap.appendChild(descArea);

    field("Fasiliteter (kommaseparert)", "facilities", "F.eks. Stupebrett, Toalett, Parkering");
    var hint = document.createElement("div");
    hint.className = "facility-input-hint";
    hint.textContent = "Skill med komma.";
    wrap.appendChild(hint);

    if (!state.myUser) {
      var signInHint = document.createElement("div");
      signInHint.className = "inline-banner info";
      signInHint.style.marginTop = "14px";
      signInHint.textContent = requireSignInMessage();
      wrap.appendChild(signInHint);
    }
    if (state._addError) {
      var err = document.createElement("div");
      err.className = "inline-banner";
      err.style.marginTop = "14px";
      err.textContent = state._addError;
      wrap.appendChild(err);
    }

    var btnRow = document.createElement("div");
    btnRow.style.marginTop = "16px";
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    var save = document.createElement("button");
    save.className = "btn btn-accent";
    save.textContent = "Lagre badeplass";
    save.disabled = !state.myUser;
    save.addEventListener("click", function () {
      var ns = state._newSpot;
      if (!ns.name || !ns.name.trim()) { state._addError = "Gi badeplassen et navn."; render(); return; }
      var isBade = ns.type !== "sauna";
      if (isBade && WATER_TYPES.indexOf(ns.water) === -1) { state._addError = "Velg om badeplassen er ved saltvann, innsjø eller elv."; render(); return; }
      if (!state.myUser) { state._addError = requireSignInMessage(); render(); return; }
      save.disabled = true;
      db.collection("spots").add({
        name: ns.name.trim(),
        kommune: (ns.kommune || "").trim() || "Ukjent",
        fylke: (ns.fylke || "").trim(),
        type: ns.type === "sauna" ? "sauna" : "badeplass",
        water: isBade ? ns.water : null,
        visibility: ns.visibility === "private" ? "private" : "public",
        lat: ns.lat, lon: ns.lon,
        desc: (ns.desc || "").trim(),
        facilities: (ns.facilities || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean),
        addedBy: state.myUser.uid,
        addedByName: state.myUser.displayName || "en venn",
        official: false,
        createdAt: new Date().toISOString()
      }).then(function (ref) {
        state.formMode = null; state._newSpot = null; state.selectedId = ref.id;
        render();
      }).catch(function (err) { state._addError = dbErrorMessage(err); save.disabled = false; render(); });
    });
    btnRow.appendChild(save);

    var cancel = document.createElement("button");
    cancel.className = "btn btn-ghost";
    cancel.textContent = "Avbryt";
    cancel.addEventListener("click", function () { state.formMode = null; state._newSpot = null; render(); });
    btnRow.appendChild(cancel);

    wrap.appendChild(btnRow);
    return wrap;
  }

  function renderList() {
    listView.innerHTML = "";
    var toolbar = document.createElement("div");
    toolbar.className = "list-toolbar";
    var note = document.createElement("div");
    note.className = "rating-count";
    note.textContent = visibleSpots().length + " badeplasser";
    toolbar.appendChild(note);
    listView.appendChild(toolbar);

    var groups = {};
    visibleSpots().forEach(function (s) {
      var fy = s.fylke || "Ukjent fylke";
      var ko = s.kommune || "Ukjent kommune";
      groups[fy] = groups[fy] || {};
      groups[fy][ko] = groups[fy][ko] || [];
      groups[fy][ko].push(s);
    });
    var fylkeNames = Object.keys(groups).sort();
    if (!fylkeNames.length) {
      var e = document.createElement("div");
      e.className = "panel-empty";
      e.textContent = "Ingen badeplasser funnet.";
      listView.appendChild(e);
      return;
    }
    fylkeNames.forEach(function (fy) {
      var fh = document.createElement("div");
      fh.className = "list-group-title-fylke";
      fh.textContent = fy;
      listView.appendChild(fh);
      Object.keys(groups[fy]).sort().forEach(function (ko) {
        var kh = document.createElement("div");
        kh.className = "list-group-title-kommune";
        kh.textContent = ko;
        listView.appendChild(kh);
        groups[fy][ko].sort(function (a, b) {
          var ra = aggregateRatings(state.checkins, a.id).avg || 0;
          var rb = aggregateRatings(state.checkins, b.id).avg || 0;
          return rb - ra;
        }).forEach(function (s) { listView.appendChild(buildSpotRow(s)); });
      });
    });
  }

  function buildSpotRow(s) {
    var row = document.createElement("div");
    row.className = "spot-row";
    var agg = aggregateRatings(state.checkins, s.id);
    var dot = document.createElement("span");
    dot.className = "spot-row-dot";
    dot.style.background = ratingColor(agg.avg, agg.count);
    row.appendChild(dot);

    var main = document.createElement("div");
    main.className = "spot-row-main";
    var name = document.createElement("div");
    name.className = "spot-row-name";
    name.textContent = (s.type === "sauna" ? "♨️ " : "") + (s.name || "Badeplass");
    main.appendChild(name);
    var sub = document.createElement("div");
    sub.className = "spot-row-sub";
    sub.textContent = (s.district ? s.district + ", " : "") + (s.kommune || "");
    main.appendChild(sub);
    row.appendChild(main);

    var rt = document.createElement("div");
    rt.className = "spot-row-rating";
    var st = document.createElement("div");
    st.className = "stars";
    st.style.fontSize = "13px";
    st.textContent = agg.count ? starString(agg.avg) : "–";
    rt.appendChild(st);
    var cnt = document.createElement("div");
    cnt.className = "rating-count";
    cnt.textContent = agg.count ? agg.count + " sjekk-inn" : "Ingen enda";
    rt.appendChild(cnt);
    row.appendChild(rt);

    row.addEventListener("click", function () { selectSpot(s.id); });
    return row;
  }

  function renderMine() {
    mineView.innerHTML = "";
    if (!state.myUser) {
      var e = document.createElement("div");
      e.className = "panel-empty";
      e.textContent = "Logg inn for å se dine badeturer.";
      mineView.appendChild(e);
      return;
    }
    var mine = state.checkins.filter(function (c) { return c.userId === state.myUser.uid; });

    var stats = document.createElement("div");
    stats.className = "mine-stats";
    var uniqueSpots = Array.from(new Set(mine.map(function (c) { return c.spotId; }))).length;
    var avg = mine.length ? (mine.reduce(function (a, c) { return a + c.rating; }, 0) / mine.length) : 0;
    [["Sjekk-inn", mine.length], ["Badeplasser", uniqueSpots], ["Snittvurdering", mine.length ? avg.toFixed(1) : "–"]].forEach(function (pair) {
      var card = document.createElement("div");
      card.className = "mine-stat";
      var b = document.createElement("b"); b.textContent = pair[1];
      var sp = document.createElement("span"); sp.textContent = pair[0];
      card.appendChild(b); card.appendChild(sp);
      stats.appendChild(card);
    });
    mineView.appendChild(stats);

    if (!mine.length) {
      var e2 = document.createElement("div");
      e2.className = "panel-empty";
      e2.textContent = "Du har ikke sjekket inn noen steder enda. Finn en badeplass i kartet!";
      mineView.appendChild(e2);
      return;
    }

    mine.forEach(function (c) {
      var spot = state.spots.filter(function (s) { return s.id === c.spotId; })[0];
      var card = document.createElement("div");
      card.className = "mine-card";
      var head = document.createElement("div");
      head.className = "mine-card-head";
      var name = document.createElement("div");
      name.className = "mine-card-spot";
      name.textContent = spot ? spot.name : "Ukjent badeplass";
      if (spot) name.addEventListener("click", function () { selectSpot(spot.id); });
      head.appendChild(name);
      var time = document.createElement("span");
      time.className = "checkin-time";
      time.textContent = relativeTime(c.createdAt);
      head.appendChild(time);
      card.appendChild(head);

      var stars = document.createElement("div");
      stars.className = "stars";
      stars.style.fontSize = "14px";
      stars.textContent = starString(c.rating);
      card.appendChild(stars);

      if (c.comment) {
        var com = document.createElement("div");
        com.className = "checkin-comment";
        com.style.marginTop = "6px";
        com.textContent = c.comment;
        card.appendChild(com);
      }
      mineView.appendChild(card);
    });
  }

  // ---------------- Wiring ----------------
  Array.prototype.forEach.call(document.querySelectorAll(".view-tabs button"), function (b) {
    b.addEventListener("click", function () {
      state.view = b.getAttribute("data-view");
      exitPlacing();
      render();
    });
  });

  function startAddSpot() {
    if (!state.myUser) { auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).then(function () { enterPlacing(); }); return; }
    state.formMode = null;
    enterPlacing();
  }
  document.getElementById("addSpotBtn").addEventListener("click", startAddSpot);
  document.getElementById("addSpotFab").addEventListener("click", startAddSpot);
  document.getElementById("cancelAdd").addEventListener("click", exitPlacing);
  function closePanel() {
    sidePanel.classList.remove("open");
    state.selectedId = null; state.formMode = null; state._newSpot = null;
    render();
  }
  document.getElementById("panelClose").addEventListener("click", closePanel);
  document.getElementById("panelCloseBtn").addEventListener("click", closePanel);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return; // the search field handles its own Escape
    if (photoLightbox.style.display === "flex") { closeLightbox(); return; }
    if (state.placing) { exitPlacing(); render(); return; }
    if (state.selectedId || state.formMode) closePanel();
  });
  searchBox.addEventListener("input", function () { state.search = searchBox.value; searchActive = -1; render(); renderSearchResults(); });
  fylkeFilterEl.addEventListener("change", function () {
    state.fylkeFilter = fylkeFilterEl.value;
    state.kommuneFilter = "all";
    populateKommuneFilter();
    pendingFlyTo = true;
    render();
  });
  kommuneFilterEl.addEventListener("change", function () {
    state.kommuneFilter = kommuneFilterEl.value;
    pendingFlyTo = true;
    render();
  });
  typeFilterEl.addEventListener("change", function () { state.typeFilter = typeFilterEl.value; render(); });
  waterFilterEl.addEventListener("change", function () { state.waterFilter = waterFilterEl.value; render(); });

  // Phones: the three dropdowns hide behind a "Filter" button (CSS); the badge counts active filters.
  var filterToggle = document.getElementById("filterToggle");
  var filterCount = document.getElementById("filterCount");
  var mapToolbar = document.querySelector(".map-toolbar");
  function setFiltersOpen(open) {
    mapToolbar.classList.toggle("filters-open", open);
    filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) hideSearchResults();
  }
  filterToggle.addEventListener("click", function () { setFiltersOpen(!mapToolbar.classList.contains("filters-open")); });
  document.getElementById("filterDone").addEventListener("click", function () { setFiltersOpen(false); });
  document.getElementById("filterReset").addEventListener("click", function () {
    state.fylkeFilter = "all"; state.kommuneFilter = "all"; state.typeFilter = "all"; state.waterFilter = "all";
    fylkeFilterEl.value = "all"; typeFilterEl.value = "all"; waterFilterEl.value = "all";
    populateKommuneFilter(); kommuneFilterEl.value = "all";
    pendingFlyTo = true;
    render();
  });

  // ---------------- Search: live results under the field ----------------
  var searchResults = document.getElementById("searchResults");
  var searchHits = [];
  var searchActive = -1;
  function hideSearchResults() { searchResults.hidden = true; searchResults.innerHTML = ""; searchActive = -1; }
  function rankHits(q) {
    // same matching as the map/list filter, best name matches first
    return visibleSpots().map(function (s) {
      var n = (s.name || "").toLowerCase();
      var rank = n.indexOf(q) === 0 ? 0 : (n.indexOf(q) !== -1 ? 1 : ((s.kommune || "").toLowerCase().indexOf(q) !== -1 ? 2 : 3));
      return { s: s, rank: rank };
    }).sort(function (a, b) { return a.rank - b.rank || (a.s.name || "").localeCompare(b.s.name || "", "nb"); })
      .slice(0, 8).map(function (x) { return x.s; });
  }
  function renderSearchResults() {
    var q = state.search.trim().toLowerCase();
    if (!q) { hideSearchResults(); return; }
    searchHits = rankHits(q);
    searchResults.innerHTML = "";
    if (!searchHits.length) {
      var empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = !state.spotsLoaded ? "Badeplassene lastes fortsatt inn…" : "Ingen treff for «" + state.search.trim() + "»";
      searchResults.appendChild(empty);
    }
    searchHits.forEach(function (s, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "search-result" + (i === searchActive ? " active" : "");
      b.setAttribute("role", "option");
      var dot = document.createElement("span");
      dot.className = "sr-dot";
      var agg = aggregateRatings(state.checkins, s.id);
      dot.style.background = ratingColor(agg.avg, agg.count);
      var txt = document.createElement("span");
      var nm = document.createElement("span"); nm.className = "sr-name";
      nm.textContent = (s.type === "sauna" ? "♨️ " : "") + (s.name || "Badeplass");
      var sub = document.createElement("span"); sub.className = "sr-sub";
      sub.textContent = [s.kommune, s.fylke].filter(Boolean).join(" · ");
      txt.appendChild(nm); txt.appendChild(sub);
      b.appendChild(dot); b.appendChild(txt);
      b.addEventListener("click", function () { chooseSearchHit(s); });
      searchResults.appendChild(b);
    });
    searchResults.hidden = false;
  }
  function chooseSearchHit(s) {
    // clear the text so no markers stay dimmed, close the keyboard, then fly to the spot
    state.search = ""; searchBox.value = "";
    hideSearchResults();
    searchBox.blur();
    selectSpot(s.id);
  }
  // keep focus in the field while a result is being tapped (otherwise blur would close the list first)
  searchResults.addEventListener("pointerdown", function (e) { e.preventDefault(); });
  searchResults.addEventListener("mousedown", function (e) { e.preventDefault(); });
  searchBox.addEventListener("focus", function () { setFiltersOpen(false); if (state.search.trim()) renderSearchResults(); });
  searchBox.addEventListener("blur", function () { setTimeout(hideSearchResults, 150); });
  searchBox.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      var hit = searchHits[searchActive >= 0 ? searchActive : 0];
      if (state.search.trim() && hit) chooseSearchHit(hit);
    } else if (e.key === "Escape") {
      hideSearchResults(); searchBox.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!searchHits.length) return;
      e.preventDefault();
      searchActive = (searchActive + (e.key === "ArrowDown" ? 1 : -1) + searchHits.length) % searchHits.length;
      renderSearchResults();
    }
  });

  // ---------------- Legend: collapsible, remembers the choice ----------------
  var mapLegend = document.getElementById("mapLegend");
  var legendToggle = document.getElementById("legendToggle");
  function setLegendOpen(open, remember) {
    mapLegend.classList.toggle("collapsed", !open);
    legendToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (remember) { try { localStorage.setItem("badekulpen.legendOpen", open ? "1" : "0"); } catch (e) {} }
  }
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("badekulpen.legendOpen"); } catch (e) {}
    var open = saved === null ? !window.matchMedia("(max-width: 820px)").matches : saved === "1";
    setLegendOpen(open, false);
  })();
  legendToggle.addEventListener("click", function () { setLegendOpen(mapLegend.classList.contains("collapsed"), true); });
  function renderFilterCount() {
    if (!filterCount) return; // render() can run before this part of the script has executed
    var n = [state.fylkeFilter, state.kommuneFilter, state.typeFilter, state.waterFilter].filter(function (v) { return v !== "all"; }).length;
    filterCount.textContent = n ? String(n) : "";
  }
  sharedBannerClose.addEventListener("click", clearSharedList);

  // ---------------- Fallback: plain REST reads when the Firebase SDK never answers ----------------
  // Seen in Messenger's in-app browser on iPhone: the Firestore SDK waits for Firebase Auth to finish starting,
  // and on iOS Auth first loads Google's sign-in frame, which can hang there - so nothing ever loads and no
  // error is raised. Reading is public (see firestore.rules), so fetch the same data straight from Firestore's
  // REST API instead. If the SDK answers later, its live data simply replaces this snapshot.
  var REST_FALLBACK_AFTER_MS = 4000;
  var restBase = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(cfg.projectId) + "/databases/(default)/documents/";
  var restStarted = false;
  function fsValue(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValue);
    if ("mapValue" in v) { var o = {}, f = v.mapValue.fields || {}; Object.keys(f).forEach(function (k) { o[k] = fsValue(f[k]); }); return o; }
    return null; // nullValue and anything unexpected
  }
  function fsDoc(d) {
    var o = fsValue({ mapValue: { fields: d.fields || {} } });
    o.id = d.name.split("/").pop();
    return o;
  }
  function restList(coll) {
    var out = [];
    function page(token) {
      var url = restBase + coll + "?pageSize=300&key=" + encodeURIComponent(cfg.apiKey) + (token ? "&pageToken=" + encodeURIComponent(token) : "");
      return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { (j.documents || []).forEach(function (d) { out.push(fsDoc(d)); }); return j.nextPageToken ? page(j.nextPageToken) : out; });
    }
    return page(null);
  }
  function restGet(coll, id) {
    return fetch(restBase + coll + "/" + encodeURIComponent(id) + "?key=" + encodeURIComponent(cfg.apiKey)).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json().then(fsDoc);
    });
  }
  function loadViaRestFallback() {
    if (restStarted) return;
    restStarted = true;
    restList("spots").then(function (list) {
      if (state.spotsSource !== "sdk") { state.spotsSource = "rest"; applySpots(list); }
    }).catch(function () {
      if (!state.spotsLoaded) {
        state.spotsError = "Fikk ikke hentet badeplassene. Sjekk nettet, eller åpne siden i Safari eller Chrome (i Messenger: ••• → Åpne i Safari).";
        render();
      }
    });
    restList("checkins").then(function (list) {
      if (state.checkinsSource !== "sdk") { state.checkinsSource = "rest"; applyCheckins(list); }
    }).catch(function () { /* ratings just stay empty */ });
    if (state.sharedListId && state.sharedListSource !== "sdk") {
      restGet("lists", state.sharedListId).then(function (data) {
        if (state.sharedListSource !== "sdk") { state.sharedListSource = "rest"; applySharedList(data); }
      }).catch(function () {});
    }
  }
  setTimeout(function () { if (!state.spotsLoaded) loadViaRestFallback(); }, REST_FALLBACK_AFTER_MS);

  // ?debug=1 shows where the data came from and whether sign-in finished starting (for troubleshooting on phones)
  if (/[?&]debug=1/.test(location.search)) {
    var dbg = document.createElement("div");
    dbg.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;background:#000c;color:#fff;font:12px/1.4 monospace;padding:6px 8px;border-radius:8px;pointer-events:none";
    document.body.appendChild(dbg);
    var t0 = Date.now();
    setInterval(function () {
      dbg.textContent = "t=" + Math.round((Date.now() - t0) / 1000) + "s  data: " + (state.spotsSource || "venter") +
        " (" + state.spots.length + ")  innlogging: " + (state.authReady ? "klar" : "venter");
    }, 500);
  }

  // ---------------- Shared list via ?liste=<id>, or a single shared spot via ?sted=<id> ----------------
  (function () {
    var params = new URLSearchParams(location.search);
    var listeId = params.get("liste");
    var stedId = params.get("sted");
    if (listeId) {
      state.sharedListId = listeId;
      subscribeSharedList(listeId);
    } else if (stedId) {
      // The matching spot (if any) is picked out and auto-selected once the
      // normal spots subscription above has loaded — see its onSnapshot.
      state.sharedSpotId = stedId;
    }
  })();

  render();
})();
