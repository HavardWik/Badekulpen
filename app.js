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

  function ratingColor(avg, count) {
    if (!count) return "#1B6E8C";
    if (avg >= 4.5) return "#2E8C58";
    if (avg >= 3) return "#C99A33";
    return "#BD5339";
  }

  // ---------------- State ----------------
  var state = {
    myUser: null,       // firebase.User | null
    spots: [],
    checkins: [],
    view: "map",
    selectedId: null,
    placing: false,
    search: "",
    cityFilter: "all",
    formMode: null,
    dbError: null,
    _pendingRating: 0,
    _pendingComment: "",
    _newSpot: null,
    _addError: null,
    _confirmDelete: null,
    _confirmDeleteSpot: null
  };

  var mapPaneEl = document.getElementById("mapPane");
  var sidePanel = document.getElementById("sidePanel");
  var panelBody = document.getElementById("panelBody");
  var listView = document.getElementById("listView");
  var mineView = document.getElementById("mineView");
  var addBanner = document.getElementById("addBanner");
  var searchBox = document.getElementById("searchBox");
  var cityFilterEl = document.getElementById("cityFilter");
  var signInBtn = document.getElementById("signInBtn");
  var signOutBtn = document.getElementById("signOutBtn");
  var viewerChip = document.getElementById("viewerChip");
  var viewerAvatar = document.getElementById("viewerAvatar");
  var viewerName = document.getElementById("viewerName");

  // ---------------- Auth ----------------
  signInBtn.addEventListener("click", function () {
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function (err) {
      alert("Kunne ikke logge inn: " + (err && err.message ? err.message : err));
    });
  });
  signOutBtn.addEventListener("click", function () { auth.signOut(); });

  auth.onAuthStateChanged(function (user) {
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

  db.collection("spots").onSnapshot(function (snap) {
    state.dbError = null;
    state.spots = snap.docs.map(function (d) {
      var data = d.data() || {};
      data.id = d.id;
      return data;
    });
    populateCityFilter();
    render();
  }, function (err) {
    state.dbError = dbErrorMessage(err);
    render();
  });

  db.collection("checkins").onSnapshot(function (snap) {
    state.checkins = snap.docs.map(function (d) {
      var data = d.data() || {};
      data.id = d.id;
      return data;
    }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    render();
  }, function (err) {
    state.dbError = dbErrorMessage(err);
    render();
  });

  function populateCityFilter() {
    var cities = Array.from(new Set(state.spots.map(function (s) { return s.city; }).filter(Boolean))).sort();
    var current = cityFilterEl.value || "all";
    cityFilterEl.innerHTML = '<option value="all">Alle byer</option>' +
      cities.map(function (c) { return '<option value="' + c.replace(/"/g, "") + '">' + c + "</option>"; }).join("");
    cityFilterEl.value = cities.indexOf(current) >= 0 ? current : "all";
  }

  function visibleSpots() {
    var q = state.search.trim().toLowerCase();
    return state.spots.filter(function (s) {
      if (state.cityFilter !== "all" && s.city !== state.cityFilter) return false;
      if (!q) return true;
      var hay = ((s.name || "") + " " + (s.district || "") + " " + (s.city || "") + " " + (s.desc || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // ---------------- Leaflet map ----------------
  var DEFAULT_CENTER = [60.39, 5.32]; // Bergen
  var map = L.map("map", { zoomControl: true }).setView(DEFAULT_CENTER, 11);

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

  map.on("click", function (e) {
    if (!state.placing) return;
    exitPlacing();
    openAddForm(e.latlng.lat, e.latlng.lng);
  });

  function renderMap() {
    markerLayer.clearLayers();
    var spots = state.spots;
    var visible = visibleSpots();
    var visibleIds = {};
    visible.forEach(function (s) { visibleIds[s.id] = true; });

    spots.forEach(function (s) {
      if (typeof s.lat !== "number" || typeof s.lon !== "number") return;
      var agg = aggregateRatings(state.checkins, s.id);
      var dimmed = !visibleIds[s.id];
      var radius = 7 + Math.min(agg.count, 9);
      var marker = L.circleMarker([s.lat, s.lon], {
        radius: radius,
        color: "#fff",
        weight: 2,
        fillColor: ratingColor(agg.avg, agg.count),
        fillOpacity: dimmed ? 0.25 : 0.95,
        opacity: dimmed ? 0.25 : 1
      });
      marker.on("click", function () { selectSpot(s.id); });
      marker.addTo(markerLayer);
    });

    if (!hasFitOnce && spots.length) {
      var bounds = L.latLngBounds(spots.filter(function (s) { return typeof s.lat === "number"; }).map(function (s) { return [s.lat, s.lon]; }));
      if (bounds.isValid()) { map.fitBounds(bounds.pad(0.25)); hasFitOnce = true; }
    }
  }

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
  }

  function selectSpot(id) {
    state.selectedId = id;
    state.formMode = null;
    state.view = "map";
    sidePanel.classList.add("open");
    render();
  }

  // ---------------- Rendering ----------------
  function render() {
    renderTabs();
    renderMap();
    if (state.view === "map") {
      mapPaneEl.style.display = "block"; sidePanel.style.display = "block";
      listView.style.display = "none"; mineView.style.display = "none";
      setTimeout(function () { map.invalidateSize(); }, 0);
    } else if (state.view === "list") {
      mapPaneEl.style.display = "none"; sidePanel.style.display = "block";
      listView.style.display = "block"; mineView.style.display = "none";
      renderList();
    } else {
      mapPaneEl.style.display = "none"; sidePanel.style.display = "none";
      listView.style.display = "none"; mineView.style.display = "block";
      renderMine();
    }
    renderPanel();
  }

  function renderTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".view-tabs button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === state.view);
    });
  }

  function renderPanel() {
    var spot = state.spots.filter(function (s) { return s.id === state.selectedId; })[0];
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
    cityChip.textContent = (spot.district ? spot.district + ", " : "") + (spot.city || "");
    meta.appendChild(cityChip);
    if (spot.official) {
      var oc = document.createElement("span");
      oc.className = "chip official";
      oc.textContent = "✓ Kommunal badeplass";
      meta.appendChild(oc);
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

    if (state.myUser && spot.addedBy && spot.addedBy === state.myUser.uid && !spot.official) {
      var manageLbl = document.createElement("div");
      manageLbl.className = "section-label";
      manageLbl.textContent = "Administrer";
      wrap.appendChild(manageLbl);
      wrap.appendChild(buildDeleteSpotControl(spot));
    }

    panelBody.appendChild(wrap);
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

    var row = document.createElement("div");
    row.style.marginTop = "10px";
    var submit = document.createElement("button");
    submit.className = "btn btn-warm";
    submit.textContent = "Sjekk inn";
    submit.disabled = !state.myUser || !myRating;
    submit.addEventListener("click", function () {
      if (!state.myUser) return;
      submit.disabled = true;
      db.collection("checkins").add({
        spotId: spot.id,
        userId: state.myUser.uid,
        userName: state.myUser.displayName || "En venn",
        userPhoto: state.myUser.photoURL || "",
        rating: state._pendingRating,
        comment: (state._pendingComment || "").trim().slice(0, 500),
        createdAt: new Date().toISOString()
      }).then(function () {
        state._pendingRating = 0; state._pendingComment = "";
        render();
      }).catch(function (err) { state.dbError = dbErrorMessage(err); render(); });
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

  function openAddForm(lat, lon) {
    state.formMode = "add";
    state._newSpot = { lat: lat, lon: lon, name: "", city: "Bergen", district: "", desc: "", facilities: "" };
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
    field("By / sted", "city", "F.eks. Bergen");
    field("Bydel / område", "district", "F.eks. Bergenhus");

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
      if (!state.myUser) { state._addError = requireSignInMessage(); render(); return; }
      save.disabled = true;
      db.collection("spots").add({
        name: ns.name.trim(),
        city: (ns.city || "").trim() || "Ukjent",
        district: (ns.district || "").trim(),
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
      var key = s.city || "Ukjent";
      groups[key] = groups[key] || [];
      groups[key].push(s);
    });
    var cityNames = Object.keys(groups).sort();
    if (!cityNames.length) {
      var e = document.createElement("div");
      e.className = "panel-empty";
      e.textContent = "Ingen badeplasser funnet.";
      listView.appendChild(e);
      return;
    }
    cityNames.forEach(function (city) {
      var h = document.createElement("div");
      h.className = "list-group-title";
      h.textContent = city;
      listView.appendChild(h);
      groups[city].sort(function (a, b) {
        var ra = aggregateRatings(state.checkins, a.id).avg || 0;
        var rb = aggregateRatings(state.checkins, b.id).avg || 0;
        return rb - ra;
      }).forEach(function (s) { listView.appendChild(buildSpotRow(s)); });
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
    name.textContent = s.name || "Badeplass";
    main.appendChild(name);
    var sub = document.createElement("div");
    sub.className = "spot-row-sub";
    sub.textContent = (s.district ? s.district + ", " : "") + (s.city || "");
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

  document.getElementById("addSpotBtn").addEventListener("click", function () {
    if (!state.myUser) { auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).then(function () { enterPlacing(); }); return; }
    state.formMode = null;
    enterPlacing();
  });
  document.getElementById("cancelAdd").addEventListener("click", exitPlacing);
  document.getElementById("panelClose").addEventListener("click", function () {
    sidePanel.classList.remove("open");
    state.selectedId = null; state.formMode = null;
    render();
  });
  searchBox.addEventListener("input", function () { state.search = searchBox.value; render(); });
  cityFilterEl.addEventListener("change", function () { state.cityFilter = cityFilterEl.value; render(); });

  render();
})();
