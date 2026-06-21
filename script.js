document.addEventListener("DOMContentLoaded", initializePage);

const HIDDEN_CATEGORIES_DEFAULT = ["Fleisch & Wurst", "Drogerie", "Tiernahrung", "Fisch & Meeresfrüchte"];

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
    const option = document.createElement("option");
    option.value = file;
    // "2026/KW11/2026-03-09.json" → "KW11 — 09.03.2026"
    const match = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
    if (match) {
      option.textContent = `${match[2]} — ${match[5]}.${match[4]}.${match[1]}`;
    } else {
      option.textContent = file;
    }
    dropdown.appendChild(option);
  });
}

async function fetchOffers(filePath) {
  const fullPath = `data/${filePath}`;
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
      // Precompute a lowercased search blob (title + category + description)
      // so the search handler does not read every cell on each keystroke.
      row.dataset.search = `${offer.title} ${offer.category.name} ${offer.description}`.toLowerCase();

      const cells = [
        offer.id,
        offer.title,
        offer.category.name,
        `${offer.price.value} €`,
        offer.description,
      ];
      cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        row.appendChild(td);
      });

      // Image cell with data attributes. Use web90 (purpose-built thumbnail)
      // instead of app (full-size) since CSS caps it at 80x60.
      const imgCell = document.createElement("td");
      imgCell.className = "image-cell hidden";
      imgCell.dataset.imageUrl = offer.images.web90 || offer.images.app || "";
      imgCell.dataset.originalUrl = offer.images.original || "";
      row.appendChild(imgCell);

      fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);

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
  // Normalize comma to dot so "1,99" matches the "1.99" price values.
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
    });
}

function setupToggleImages() {
  const toggleImagesButton = document.getElementById("toggle-images");
  const imageHeader = document.getElementById("image-column-header");

  if (!toggleImagesButton || !imageHeader) return;

  toggleImagesButton.addEventListener("click", () => {
    const imageCells = document.querySelectorAll(".image-cell");
    const isHidden = imageHeader.classList.contains("hidden");

    imageCells.forEach((cell) => {
      if (isHidden) {
        // Show images
        const imgUrl = safeImageUrl(cell.getAttribute("data-image-url"));
        if (imgUrl && !cell.querySelector("img")) {
          const img = document.createElement("img");
          img.src = imgUrl;
          img.alt = "Produktbild";
          img.loading = "lazy";
          img.style.cursor = "zoom-in";
          // Activate the .img-error { display:none } rule on broken images.
          img.onerror = () => img.classList.add("img-error");
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

    // Attach hover preview if images are shown
    if (isHidden) attachImageHoverPreview();
  });
}

function attachImageHoverPreview() {
  const table = document.getElementById("offer-table");
  const imagePreview = document.getElementById("image-preview");

  if (!table || !imagePreview) return;

  table.addEventListener("mouseover", (event) => {
    const imgCell = event.target.closest(".image-cell img");
    if (!imgCell) return;

    const originalUrl = safeImageUrl(
      imgCell.closest(".image-cell").dataset.originalUrl || ""
    );
    if (originalUrl) {
      imagePreview.innerHTML = `<img src="${escapeHtml(originalUrl)}" alt="Vorschau" loading="lazy">`;
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
