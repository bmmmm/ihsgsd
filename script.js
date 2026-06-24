document.addEventListener("DOMContentLoaded", initializePage);

const HIDDEN_CATEGORIES_DEFAULT = ["Fleisch & Wurst", "Drogerie", "Tiernahrung", "Fisch & Meeresfrüchte"];

// Guard so attachImageHoverPreview() registers its listeners only once.
let hoverPreviewAttached = false;

const SEARCH_DEBOUNCE_MS = 120;

// Extract the "YYYY-MM-DD" date embedded in a data file path for sorting.
function fileDate(file) {
  const m = file.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : "";
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

function populateDropdown(dropdown, files) {
  dropdown.innerHTML = "";
  files.forEach((file) => {
    // "2026/KW11/2026-03-09.json" → "KW11 — 09.03.2026". Skip non-week artifacts
    // (e.g. insights.json) so they can't become a junk option that errors on load.
    const match = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
    if (!match) return;
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

    tableBody.innerHTML = "";
    const fragment = document.createDocumentFragment();
    offers.forEach((offer) => {
      const row = document.createElement("tr");
      row.dataset.category = offer.category.name;
      // Precompute a lowercased search blob (title + category + description +
      // price) so the search handler does not read every cell on each keystroke.
      // Commas are normalized to dots so "1,5 l" and a query of "1,5" both
      // become "1.5" and match (same normalization applied to the query in applyFilters).
      // The displayed price uses rawValue (falling back to parsed value); include
      // it in the blob alongside the raw price.value so a search for the number
      // shown in the price cell matches even when the two disagree (e.g. the one
      // real rawValue:0 item).
      const priceShown = (Number.isFinite(offer.price.rawValue) ? offer.price.rawValue : parseFloat(offer.price.value)).toFixed(2);
      row.dataset.search = `${offer.title} ${offer.category.name} ${offer.description} ${offer.price.value} ${priceShown}`
        .toLowerCase()
        .replace(/,/g, ".");

      const cells = [
        offer.id,
        offer.title,
        offer.category.name,
        `${priceShown} €`,
        offer.description,
      ];
      cells.forEach((text) => {
        const td = document.createElement("td");
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
      imgCell.dataset.localUrl = `data/${weekDir}/img/${encodeURIComponent(offer.id)}.jpg`;
      imgCell.dataset.imageUrl = offer.images.app || "";
      imgCell.dataset.originalUrl = offer.images.original || "";
      row.appendChild(imgCell);

      fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);

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

function copyVisibleProducts() {
  const rows = document.querySelectorAll("#offer-table tr:not(.hidden)");
  const products = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length) {
      const product = {
        id: cells[0].textContent.trim(),
        title: cells[1].textContent.trim(),
        category: cells[2].textContent.trim(),
        price: cells[3].textContent.trim(),
        description: cells[4].textContent.trim(),
      };
      products.push(product);
    }
  });

  const jsonString = JSON.stringify(products, null, 2);

  // Add LLM-friendly instructions and formatting
  const promptString = `
[LLM PROMPT START]
Below is a JSON list of filtered products. Use this data to answer questions, generate summaries, or provide insights based on the product information.

\`\`\`json
${jsonString}
\`\`\`

Please follow the steps below in your response:
1. Reference product data by 'id' or 'title'.
2. If you need to provide reasoning, consider the context of 'category', 'price', and 'description'.
3. Keep answers factual and based on the provided data.

[LLM PROMPT END]
`;

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

function attachImageHoverPreview() {
  if (hoverPreviewAttached) return;
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
    if (originalUrl) {
      const previewImg = document.createElement("img");
      previewImg.src = originalUrl;
      previewImg.alt = "Vorschau";
      previewImg.loading = "lazy";
      // If the original URL 404s, fall back to the app thumbnail once.
      previewImg.onerror = function () {
        this.onerror = null; // prevent infinite loop
        if (fallbackUrl) this.src = fallbackUrl;
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
