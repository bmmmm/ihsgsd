document.addEventListener("DOMContentLoaded", initializePage);

const HIDDEN_CATEGORIES_DEFAULT = ["Fleisch & Wurst", "Drogerie", "Tiernahrung", "Fisch & Meeresfrüchte"];

// Guard so attachImageHoverPreview() registers its listeners only once.
let hoverPreviewAttached = false;

// State of the currently loaded week, used by the detail-card click handler.
let currentOffers = [];
let currentWeekDir = "";
let currentWeekDate = "";

const SEARCH_DEBOUNCE_MS = 120;

// Extract the "YYYY-MM-DD" date embedded in a data file path for sorting.
function fileDate(file) {
  const m = file.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : "";
}

function isKnuller(offer) {
  return Array.isArray(offer.criteria) && offer.criteria.some((c) => c && c.name === "Superknüller");
}

// PAYBACK / App-Preis criteria as badge specs; points or multiplier included
// when the offer carries them (pbAdditionalPoints / pbPointsMultiplier).
function extraBadges(offer) {
  const out = [];
  const names = Array.isArray(offer.criteria) ? offer.criteria.map((c) => c && c.name) : [];
  if (names.includes("PAYBACK")) {
    const pts = Number.isFinite(offer.pbAdditionalPoints) ? `+${offer.pbAdditionalPoints} P`
      : Number.isFinite(offer.pbPointsMultiplier) ? `${offer.pbPointsMultiplier}× P` : "";
    out.push({ cls: "payback-badge", text: pts ? `PAYBACK ${pts}` : "PAYBACK" });
  }
  if (names.includes("App-Preis")) out.push({ cls: "app-badge", text: "App-Preis" });
  return out;
}

// Face price as a number (rawValue preferred, matching the displayed cell).
function offerFacePrice(offer) {
  const v = Number.isFinite(offer.price.rawValue) ? offer.price.rawValue : parseFloat(offer.price.value);
  return Number.isFinite(v) ? v : null;
}

// First euro amount out of a basicPrice string like "1 kg = € 7.04" or
// "1 l = € 1.13 / € 1.51" — good enough as a sort key, not shown anywhere.
function gpSortValue(offer) {
  const m = typeof offer.basicPrice === "string" && offer.basicPrice.match(/€\s*([\d.,]+)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// HTML-escape a string before it is interpolated into innerHTML.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow http(s) image URLs; reject javascript:, data:, etc.
function safeImageUrl(url) {
  if (typeof url !== "string") return "";
  return /^https?:\/\//i.test(url.trim()) ? url : "";
}

async function initializePage() {
  const dropdown = document.getElementById("file-dropdown");
  const copyProductsButton = document.getElementById("copy-products");

  try {
    const files = await fetchFolderStructure();
    // Sort by parsed YYYY-MM-DD descending (newest first). A blind reverse()
    // breaks at the year boundary (e.g. 2025/KW01/2025-12-29.json).
    files.sort((a, b) => fileDate(b).localeCompare(fileDate(a)));
    populateDropdown(dropdown, files);

    dropdown.addEventListener("change", () => {
      const selectedFile = dropdown.value;
      if (selectedFile) {
        fetchOffers(selectedFile);
      }
    });

    if (files.length > 0) {
      dropdown.value = files[0];
      await fetchOffers(files[0]);
    }

    copyProductsButton.addEventListener("click", copyVisibleProducts);

    attachSearchFunctionality();
    setupToggleImages();
    attachDetailCard();
    attachSorting();
  } catch (error) {
    console.error("Error initializing page:", error);
  }
}

async function fetchFolderStructure() {
  try {
    const response = await fetch("data/folder-structure.json");
    if (!response.ok) {
      throw new Error(`Failed to fetch folder structure: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error fetching folder structure:", error);
    alert("Fehler: Die Ordnerstruktur konnte nicht geladen werden.");
    return [];
  }
}

// ISO-8601 week of a UTC date, as { label: "KW07", year: <ISO week-year> }.
function isoWeekOf(date) {
  const t = new Date(date.getTime());
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // shift to Thursday
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return { label: "KW" + String(week).padStart(2, "0"), year: t.getUTCFullYear() };
}

// Weeks without a snapshot between two adjacent ones ("YYYY-MM-DD", older
// first): step 7-day hops from the older date; every hop ending ≥4 days before
// the newer snapshot is a missing week. Computed from the data itself — a
// failed Monday fetch shows up here without any hardcoded week list.
function missingWeeksBetween(olderDate, newerDate) {
  const out = [];
  const cur = new Date(olderDate + "T00:00:00Z");
  const end = new Date(newerDate + "T00:00:00Z");
  for (;;) {
    cur.setUTCDate(cur.getUTCDate() + 7);
    if (end - cur < 4 * 86400000) break;
    const w = isoWeekOf(cur);
    out.push(`${w.label} ${w.year}`);
  }
  return out;
}

function missingWeekOption(text) {
  const option = document.createElement("option");
  option.disabled = true;
  option.textContent = `${text} — keine Daten`;
  return option;
}

function populateDropdown(dropdown, files) {
  dropdown.innerHTML = "";
  let prevDate = "";
  files.forEach((file) => {
    // "2026/KW11/2026-03-09.json" → "KW11 — 09.03.2026". Skip non-week artifacts
    // (e.g. insights.json) so they can't become a junk option that errors on load.
    const match = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
    if (!match) return;
    // Files come newest-first; surface any gap down to the previous (newer)
    // snapshot as disabled "keine Daten" rows so missing weeks are visible,
    // not silent. Reversed so the rows keep the list's descending order.
    const date = `${match[3]}-${match[4]}-${match[5]}`;
    if (prevDate) {
      missingWeeksBetween(date, prevDate).reverse().forEach((text) => {
        dropdown.appendChild(missingWeekOption(text));
      });
    }
    prevDate = date;
    const option = document.createElement("option");
    option.value = file;
    // Year from the filename (match[3]), not the folder (match[1]) — they differ
    // at the ISO-week/year boundary.
    option.textContent = `${match[2]} — ${match[5]}.${match[4]}.${match[3]}`;
    dropdown.appendChild(option);
  });
}

async function fetchOffers(filePath) {
  const fullPath = `data/${filePath}`;
  // Directory of the selected week, e.g. "2026/KW23" — used to build the
  // local archived-image path for each offer.
  const weekDir = filePath.replace(/\/[^/]+$/, "");
  const tableBody = document.getElementById("offer-table");
  const offerInfo = document.getElementById("offer-info");

  try {
    const response = await fetch(fullPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }

    const data = await response.json();
    const { validFrom, validTill, totalCount, offers } = data;

    offerInfo.textContent = `${totalCount} Angebote vom ${formatDate(validFrom)} bis ${formatDate(validTill)}`;

    currentOffers = offers;
    currentWeekDir = weekDir;
    currentWeekDate = fileDate(filePath);

    tableBody.innerHTML = "";
    const fragment = document.createDocumentFragment();
    offers.forEach((offer, index) => {
      const row = document.createElement("tr");
      row.dataset.category = offer.category.name;
      row.dataset.idx = String(index);
      // Precompute a lowercased search blob (title + category + description +
      // price) so the search handler does not read every cell on each keystroke.
      // Commas are normalized to dots so "1,5 l" and a query of "1,5" both
      // become "1.5" and match (same normalization applied to the query in applyFilters).
      // The displayed price uses rawValue (falling back to parsed value); include
      // it in the blob alongside the raw price.value so a search for the number
      // shown in the price cell matches even when the two disagree (e.g. the one
      // real rawValue:0 item).
      const priceShown = (Number.isFinite(offer.price.rawValue) ? offer.price.rawValue : parseFloat(offer.price.value)).toFixed(2);
      const basicPrice = typeof offer.basicPrice === "string" ? offer.basicPrice.trim() : "";
      row.dataset.search = `${offer.title} ${offer.category.name} ${offer.description} ${offer.price.value} ${priceShown} ${basicPrice}`
        .toLowerCase()
        .replace(/,/g, ".");

      const titleTd = document.createElement("td");
      titleTd.dataset.label = "Produkt";
      titleTd.textContent = offer.title;
      if (isKnuller(offer)) {
        const badge = document.createElement("span");
        badge.className = "knuller-badge";
        badge.textContent = "Knüller";
        titleTd.appendChild(badge);
      }
      extraBadges(offer).forEach((b) => {
        const badge = document.createElement("span");
        badge.className = `knuller-badge ${b.cls}`;
        badge.textContent = b.text;
        titleTd.appendChild(badge);
      });
      row.appendChild(titleTd);

      const cells = [
        { label: "Kategorie", text: offer.category.name },
        { label: "Preis", text: `${priceShown} €` },
        { label: "Grundpreis", text: basicPrice },
        { label: "Beschreibung", text: offer.description },
      ];
      cells.forEach(({ label, text }) => {
        const td = document.createElement("td");
        td.dataset.label = label;
        td.textContent = text;
        row.appendChild(td);
      });

      // Image cell with data attributes. Prefer the locally archived thumbnail
      // (data/<week>/img/<id>.jpg); fall back to the live EDEKA `app` URL. The
      // live web90 thumbnails are broken server-side (404), which is why the
      // project switched away from them in b165e1b, and EDEKA purges the live
      // images ~1-2 months after the offer ends — the local archive is what
      // keeps older weeks' images alive.
      const imgCell = document.createElement("td");
      imgCell.className = "image-cell hidden";
      imgCell.dataset.label = "Bild";
      imgCell.dataset.localUrl = `data/${weekDir}/img/${encodeURIComponent(offer.id)}.jpg`;
      imgCell.dataset.imageUrl = offer.images.app || "";
      imgCell.dataset.originalUrl = offer.images.original || "";
      row.appendChild(imgCell);

      fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);
    applySort();

    // Reset image-column UI to the hidden baseline so the toggle button stays
    // in sync after the user switches weeks while images are shown.
    const imageColHeader = document.getElementById("image-column-header");
    const toggleImagesBtn = document.getElementById("toggle-images");
    const imageCol = document.querySelector("col.col-bild");
    const imagePreview = document.getElementById("image-preview");
    if (imageColHeader) imageColHeader.classList.add("hidden");
    if (toggleImagesBtn) toggleImagesBtn.textContent = "Bilder laden";
    // Collapse the column back to 0 — the new rows render hidden with no <img>,
    // so a leftover 12% width would leave an empty gap column on the right.
    if (imageCol) imageCol.style.width = "0";
    // Clear any stuck hover preview: tableBody.innerHTML='' above detached the
    // hovered <img>, so its mouseout never fires and the panel would otherwise
    // keep showing the previous week's image.
    if (imagePreview) { imagePreview.innerHTML = ""; imagePreview.classList.remove("visible"); }

    populateCategoryCheckboxes(offers);
  } catch (error) {
    console.error("Error fetching offers:", error);
    offerInfo.textContent = "Fehler beim Laden der Angebote.";
    tableBody.innerHTML = "";
  }
}

function formatDate(dateStr) {
  // "2026-03-09" → "09.03.2026"
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function populateCategoryCheckboxes(offers) {
  const activeContainer = document.getElementById("category-filters");
  const hiddenContainer = document.getElementById("hidden-category-filters");
  if (!activeContainer) return;

  activeContainer.innerHTML = "";
  if (hiddenContainer) hiddenContainer.innerHTML = "";

  const categoryCounts = offers.reduce((counts, offer) => {
    counts[offer.category.name] = (counts[offer.category.name] || 0) + 1;
    return counts;
  }, {});

  Object.entries(categoryCounts).forEach(([category, count]) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = category;

    const isVisible = !HIDDEN_CATEGORIES_DEFAULT.includes(category);
    checkbox.checked = isVisible;
    if (isVisible) label.classList.add("checked");

    checkbox.addEventListener("change", () => {
      label.classList.toggle("checked", checkbox.checked);
      distributeCategoryLabels();
      applyFilters();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${category} (${count})`));

    if (isVisible) {
      activeContainer.appendChild(label);
    } else if (hiddenContainer) {
      hiddenContainer.appendChild(label);
    }
  });

  distributeCategoryLabels();
  applyFilters();
}

function distributeCategoryLabels() {
  const activeContainer = document.getElementById("category-filters");
  const hiddenContainer = document.getElementById("hidden-category-filters");
  if (!activeContainer || !hiddenContainer) return;

  const allLabels = [...document.querySelectorAll("#category-filters label, #hidden-category-filters label")];
  allLabels.forEach((label) => {
    const cb = label.querySelector("input[type='checkbox']");
    if (!cb) return;
    const target = cb.checked ? activeContainer : hiddenContainer;
    target.appendChild(label);
  });

  hiddenContainer.style.display = hiddenContainer.querySelectorAll("label").length > 0 ? "" : "none";
}

// Single source of truth for row visibility: a row is shown when its category
// is enabled AND it matches the search term. Called from both the category
// checkboxes and the search input so neither clobbers the other's state.
function applyFilters() {
  const checkboxes = document.querySelectorAll(
    "#category-filters input[type='checkbox'], #hidden-category-filters input[type='checkbox']"
  );
  const allowedCategories = new Set();
  checkboxes.forEach((cb) => {
    if (cb.checked) allowedCategories.add(cb.value);
  });

  const searchInput = document.getElementById("search-input");
  // Normalize comma to dot so "1,99" matches "1.99" in both prices and
  // descriptions (the search blob is pre-normalized the same way).
  const term = (searchInput ? searchInput.value : "").toLowerCase().replace(/,/g, ".").trim();

  const rows = document.querySelectorAll("#offer-table tr");
  rows.forEach((row) => {
    const categoryAllowed = allowedCategories.has(row.dataset.category);
    // Search only matches title/category/description (precomputed blob),
    // not the ID or price cell.
    const matchesSearch = term === "" || (row.dataset.search || "").includes(term);
    row.classList.toggle("hidden", !(categoryAllowed && matchesSearch));
  });
}

function attachSearchFunctionality() {
  const searchInput = document.getElementById("search-input");
  if (!searchInput) return;

  let debounceTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilters, SEARCH_DEBOUNCE_MS);
  });
}

// Sort state survives week switches (applySort re-runs after each load);
// clicking the active header flips direction, a different header resets to asc.
let currentSort = null; // { key: 'title'|'category'|'price'|'gp', dir: 1|-1 }

const SORT_VALUE = {
  title: (o) => (o.title || "").toLowerCase(),
  category: (o) => (o.category.name || "").toLowerCase(),
  price: offerFacePrice,
  gp: gpSortValue,
};

function attachSorting() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      currentSort = currentSort && currentSort.key === key
        ? { key, dir: -currentSort.dir }
        : { key, dir: 1 };
      applySort();
    });
  });
}

function applySort() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("sorted-asc", !!currentSort && th.dataset.sort === currentSort.key && currentSort.dir === 1);
    th.classList.toggle("sorted-desc", !!currentSort && th.dataset.sort === currentSort.key && currentSort.dir === -1);
  });
  if (!currentSort) return;

  const tableBody = document.getElementById("offer-table");
  const getValue = SORT_VALUE[currentSort.key];
  const rows = [...tableBody.querySelectorAll("tr")];
  rows.sort((a, b) => {
    const va = getValue(currentOffers[Number(a.dataset.idx)]);
    const vb = getValue(currentOffers[Number(b.dataset.idx)]);
    // Missing values (no price / no Grundpreis) always sink to the bottom.
    const aMissing = va === null || va === undefined || va === "";
    const bMissing = vb === null || vb === undefined || vb === "";
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * currentSort.dir;
  });
  rows.forEach((row) => tableBody.appendChild(row));
}

function copyVisibleProducts() {
  const rows = document.querySelectorAll("#offer-table tr:not(.hidden)");
  const products = [];

  rows.forEach((row) => {
    const offer = currentOffers[Number(row.dataset.idx)];
    if (!offer) return;
    const price = offerFacePrice(offer);
    products.push({
      title: offer.title,
      category: offer.category.name,
      price: price === null ? offer.price.value : `${price.toFixed(2)} €`,
      basicPrice: typeof offer.basicPrice === "string" ? offer.basicPrice : "",
      superknueller: isKnuller(offer),
      description: offer.description,
    });
  });

  const promptString = `EDEKA-Angebote (gefilterte Auswahl, Woche ab ${currentWeekDate}):\n\n\`\`\`json\n${JSON.stringify(products, null, 2)}\n\`\`\`\n`;

  navigator.clipboard
    .writeText(promptString)
    .then(() => {
      alert("Sichtbare Produkte wurden als strukturierte LLM-Prompt kopiert!");
    })
    .catch((err) => {
      console.error("Fehler beim Kopieren der Daten:", err);
      alert("Kopieren fehlgeschlagen — bitte manuell kopieren (Clipboard-Zugriff verweigert oder kein HTTPS-Kontext).");
    });
}

function setupToggleImages() {
  const toggleImagesButton = document.getElementById("toggle-images");
  const imageHeader = document.getElementById("image-column-header");
  const imageCol = document.querySelector("col.col-bild");

  if (!toggleImagesButton || !imageHeader) return;

  // Images start hidden — collapse the column immediately so no width is wasted.
  if (imageCol) imageCol.style.width = "0";

  toggleImagesButton.addEventListener("click", () => {
    const imageCells = document.querySelectorAll(".image-cell");
    const isHidden = imageHeader.classList.contains("hidden");

    imageCells.forEach((cell) => {
      if (isHidden) {
        // Show images. Prefer the locally archived thumbnail; if it is missing
        // (older week not backfilled), fall back to the live EDEKA `app` URL.
        const localUrl = cell.getAttribute("data-local-url") || "";
        const liveUrl = safeImageUrl(cell.getAttribute("data-image-url"));
        const src = localUrl || liveUrl;
        if (src && !cell.querySelector("img")) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "Produktbild";
          img.style.cursor = "zoom-in";
          if (localUrl && liveUrl) {
            img.onerror = function () {
              this.onerror = null; // fall back once, then keep broken image visible
              this.src = liveUrl;
            };
          }
          cell.appendChild(img);
        }
        cell.classList.remove("hidden");
      } else {
        // Hide images
        if (cell.querySelector("img")) {
          cell.querySelector("img").remove();
        }
        cell.classList.add("hidden");
      }
    });

    imageHeader.classList.toggle("hidden", !isHidden);
    toggleImagesButton.textContent = isHidden
      ? "Bilder ausblenden"
      : "Bilder laden";

    // Expand or collapse the image column to match visibility.
    if (imageCol) imageCol.style.width = isHidden ? "12%" : "0";

    // Attach hover preview if images are shown
    if (isHidden) attachImageHoverPreview();
  });
}

// Row click → shared product detail card (price history, stats). Delegated
// once; image-cell clicks are left alone so the zoom preview keeps working.
function attachDetailCard() {
  const tableBody = document.getElementById("offer-table");
  if (!tableBody || typeof DetailCard === "undefined") return;

  tableBody.addEventListener("click", (event) => {
    if (event.target.closest(".image-cell")) return;
    const row = event.target.closest("tr");
    if (!row || row.dataset.idx === undefined) return;
    const offer = currentOffers[Number(row.dataset.idx)];
    if (!offer) return;

    const price = Number.isFinite(offer.price.rawValue)
      ? offer.price.rawValue
      : parseFloat(offer.price.value);
    DetailCard.open({
      title: offer.title,
      category: offer.category.name,
      date: currentWeekDate,
      offer: {
        price: Number.isFinite(price) ? price : null,
        basicPrice: offer.basicPrice || "",
        description: offer.description || "",
        imageUrl: safeImageUrl((offer.images && offer.images.app) || ""),
        localImageUrl: `data/${currentWeekDir}/img/${encodeURIComponent(offer.id)}.jpg`,
      },
    });
  });
}

// True on devices with an actual pointing device (mouse/trackpad). On touch
// devices the hover preview is meaningless — tapping a row opens the shared
// detail card instead — so we never wire up the preview listeners there.
function supportsHover() {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}

function attachImageHoverPreview() {
  if (hoverPreviewAttached) return;
  if (!supportsHover()) return;
  hoverPreviewAttached = true;

  const table = document.getElementById("offer-table");
  const imagePreview = document.getElementById("image-preview");

  if (!table || !imagePreview) return;

  table.addEventListener("mouseover", (event) => {
    const imgCell = event.target.closest(".image-cell img");
    if (!imgCell) return;

    const cell = imgCell.closest(".image-cell");
    const originalUrl = safeImageUrl(cell.dataset.originalUrl || "");
    const fallbackUrl = safeImageUrl(cell.dataset.imageUrl || "");
    const localUrl = cell.dataset.localUrl || "";
    // EDEKA purges live images ~1-2 months after the offer ends, so for older
    // weeks both live URLs 404 — the archived local thumbnail is the last stop.
    const chain = [originalUrl, fallbackUrl, localUrl].filter(Boolean);
    if (chain.length) {
      const previewImg = document.createElement("img");
      previewImg.src = chain.shift();
      previewImg.alt = "Vorschau";
      previewImg.loading = "lazy";
      previewImg.onerror = function () {
        if (chain.length) {
          this.src = chain.shift();
        } else {
          this.onerror = null;
          imagePreview.classList.remove("visible");
        }
      };
      imagePreview.innerHTML = "";
      imagePreview.appendChild(previewImg);
      imagePreview.classList.add("visible");
    }
  });

  table.addEventListener("mouseout", (event) => {
    if (event.target.closest(".image-cell img")) {
      imagePreview.innerHTML = "";
      imagePreview.classList.remove("visible");
    }
  });
}
